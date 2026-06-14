import os
import re
import shutil
import datetime
import logging
from typing import Optional, List
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks, Request, Response
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
import config
import database
from database import get_db, User, UserSession, Thought, ThoughtLink, WebReference, verify_pin

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Deep Thought",
    description="Multi-user private thought console and cognitive enrichment pipeline.",
    version="1.0.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories
UPLOAD_DIR = config.DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Pydantic schemas
class LoginRequest(BaseModel):
    pin: str
    remember: bool = False

class ThoughtCreate(BaseModel):
    content: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None

class ThoughtResponse(BaseModel):
    id: int
    content: str
    created_at: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None
    category: Optional[str] = None
    processed: bool
    enrichment_summary: Optional[str] = None

# ----------------------------------------------------
# Multi-User Subdomain & Session Dependencies
# ----------------------------------------------------

def get_subdomain(request: Request) -> str:
    """
    Extracts the user subdomain from the Host header (e.g. chris.teamjames.cc -> chris).
    Defaults to 'chris' if running on localhost or raw IP for easier local testing.
    """
    host = request.headers.get("host", "")
    host_parts = host.split(":")[0].split(".")
    
    # If it is a local IP address (e.g. 127.0.0.1 or any other IP)
    is_ip = len(host_parts) == 4 and all(part.isdigit() for part in host_parts)
    
    if len(host_parts) >= 3 and not is_ip:
        subdomain = host_parts[0].lower()
        if subdomain not in ["www", "api", "app"]:
            return subdomain
    return "chris"  # Default user for localhost debugging

def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    username = get_subdomain(request)
    
    # Verify user exists in database
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=404, detail=f"User '{username}' does not exist.")
        
    token = request.cookies.get("session_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
        
    session = db.query(UserSession).filter(
        UserSession.session_token == token,
        UserSession.user_id == user.id,
        UserSession.expires_at > datetime.datetime.utcnow()
    ).first()
    
    if not session:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
        
    return user

# Startup database initialization
@app.on_event("startup")
def startup_event():
    database.init_db()
    logger.info("Deep Thought API started and SQLite DB initialized.")
    from scheduler import start_scheduler
    start_scheduler()

# ----------------------------------------------------
# Authentication APIs
# ----------------------------------------------------

@app.post("/api/auth/login")
def login(
    login_in: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db)
):
    username = get_subdomain(request)
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=404, detail="User workspace not found.")
        
    now = datetime.datetime.utcnow()
    
    # Check Lockout status
    if user.lockout_until and user.lockout_until > now:
        time_left = int((user.lockout_until - now).total_seconds())
        raise HTTPException(
            status_code=423,
            detail=f"Account locked due to multiple failed logins. Try again in {time_left} seconds."
        )
        
    # Verify PIN
    if verify_pin(login_in.pin, user.pin_salt, user.pin_hash):
        # Successful login, reset failed attempts
        user.failed_attempts = 0
        user.lockout_until = None
        
        # Issue Session token
        session_token = os.urandom(24).hex()
        expiration_hours = 24 * 30 if login_in.remember else 2 # 30 days or 2 hours
        expires_at = now + datetime.timedelta(hours=expiration_hours)
        
        session = UserSession(
            user_id=user.id,
            session_token=session_token,
            expires_at=expires_at,
            is_trusted=login_in.remember
        )
        db.add(session)
        db.commit()
        
        # Set HttpOnly Cookie
        response.set_cookie(
            key="session_token",
            value=session_token,
            httponly=True,
            secure=False,  # Set to True if serving HTTPS via Cloudflare
            samesite="lax",
            expires=expires_at
        )
        
        return {"status": "success", "username": user.username}
    else:
        # Increment failed login attempts
        user.failed_attempts += 1
        if user.failed_attempts >= 3:
            user.lockout_until = now + datetime.timedelta(seconds=90)
            db.commit()
            raise HTTPException(
                status_code=423,
                detail="Too many failed PIN attempts. Account locked for 90 seconds."
            )
        db.commit()
        attempts_left = 3 - user.failed_attempts
        raise HTTPException(
            status_code=401,
            detail=f"Incorrect login PIN. {attempts_left} attempts remaining."
        )

@app.get("/api/auth/me")
def get_me(user: User = Depends(get_current_user)):
    return {"authenticated": True, "username": user.username}

@app.post("/api/auth/logout")
def logout(response: Response, request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("session_token")
    if token:
        # Remove from Database
        db.query(UserSession).filter(UserSession.session_token == token).delete()
        db.commit()
    response.delete_cookie("session_token")
    return {"status": "logged_out"}

# ----------------------------------------------------
# Background Enrichment Task Logic
# ----------------------------------------------------

def enrich_thought_task(thought_id: int):
    """
    Worker task to enrich a captured thought: categorizes, links, and runs web crawls.
    """
    from ai_service import AIService
    db = database.SessionLocal()
    try:
        thought = db.query(Thought).filter(Thought.id == thought_id).first()
        if not thought:
            logger.warning(f"Enrichment task failed: Thought {thought_id} not found in DB.")
            return

        logger.info(f"Enriching thought {thought.id} for user {thought.user.username}...")
        
        # 1. Auto Categorize
        category = AIService.categorize_thought(thought.content)
        thought.category = category
        
        # 2. Summary & Thematic description
        summary = AIService.analyze_and_summarize(thought.content)
        thought.enrichment_summary = summary
        
        # 3. Nightly Web Research queries
        search_queries = AIService.get_search_queries(thought.content)
        for q in search_queries:
            results = AIService.search_web_ddg(q, max_results=2)
            for res in results:
                existing = db.query(WebReference).filter(
                    WebReference.thought_id == thought.id,
                    WebReference.url == res["url"]
                ).first()
                if not existing:
                    web_ref = WebReference(
                        thought_id=thought.id,
                        url=res["url"],
                        title=res["title"],
                        snippet=res["snippet"]
                    )
                    db.add(web_ref)
                    
        # 4. Thematic linking with OTHER thoughts of this user
        others = db.query(Thought).filter(
            Thought.id != thought.id,
            Thought.user_id == thought.user_id,
            Thought.processed == True
        ).all()
        
        for other in others:
            t1_words = set(re.findall(r"\w+", thought.content.lower()))
            t2_words = set(re.findall(r"\w+", other.content.lower()))
            common_words = t1_words.intersection(t2_words)
            filtered_common = {w for w in common_words if len(w) > 4}
            
            if len(filtered_common) >= 2:
                score = len(filtered_common) / max(1, min(len(t1_words), len(t2_words)))
                dup = db.query(ThoughtLink).filter(
                    ((ThoughtLink.source_id == thought.id) & (ThoughtLink.target_id == other.id)) |
                    ((ThoughtLink.source_id == other.id) & (ThoughtLink.target_id == thought.id))
                ).first()
                if not dup:
                    link = ThoughtLink(
                        source_id=thought.id,
                        target_id=other.id,
                        relationship_type="thematic",
                        similarity_score=round(score, 2),
                        description=f"Shared keywords: {', '.join(filtered_common)}"
                    )
                    db.add(link)
                    

        thought.processed = True
        db.commit()
        logger.info(f"Thought {thought_id} successfully enriched.")
    except Exception as e:
        db.rollback()
        logger.error(f"Failed enrichment pipeline for thought {thought_id}: {e}")
    finally:
        db.close()

# ----------------------------------------------------
# Thoughts APIs
# ----------------------------------------------------

@app.post("/api/thoughts", response_model=ThoughtResponse)
def create_thought(
    thought_in: ThoughtCreate,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        thought = Thought(
            user_id=user.id,
            content=thought_in.content,
            latitude=thought_in.latitude,
            longitude=thought_in.longitude,
            location_name=thought_in.location_name,
            processed=False
        )
        db.add(thought)
        db.commit()
        db.refresh(thought)
        
        background_tasks.add_task(enrich_thought_task, thought.id)
        return thought.to_dict()
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to create thought: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/thoughts/voice")
def create_voice_thought(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    latitude: Optional[float] = Form(None),
    longitude: Optional[float] = Form(None),
    location_name: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        temp_file_path = UPLOAD_DIR / f"{user.username}_{file.filename}"
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        logger.info(f"Saved audio payload: {temp_file_path}")
        
        from ai_service import AIService
        transcription = AIService.transcribe_audio(str(temp_file_path))
        
        # Cleanup file
        if temp_file_path.exists():
            os.remove(temp_file_path)
            
        if not transcription or transcription.startswith("[Transcription"):
            raise HTTPException(status_code=400, detail="Voice note transcription failed. Ensure audio has speech.")
            
        thought = Thought(
            user_id=user.id,
            content=transcription,
            latitude=latitude,
            longitude=longitude,
            location_name=location_name,
            processed=False
        )
        db.add(thought)
        db.commit()
        db.refresh(thought)
        
        background_tasks.add_task(enrich_thought_task, thought.id)
        return thought.to_dict()
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        logger.error(f"Voice thought ingestion failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/thoughts")
def list_thoughts(
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(Thought).filter(Thought.user_id == user.id)
    if category:
        query = query.filter(Thought.category == category)
    if search:
        query = query.filter(Thought.content.like(f"%{search}%"))
        
    thoughts = query.order_by(Thought.created_at.desc()).offset(offset).limit(limit).all()
    return [t.to_dict() for t in thoughts]


@app.get("/api/thoughts/{thought_id}")
def get_thought(
    thought_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    thought = db.query(Thought).filter(
        Thought.id == thought_id,
        Thought.user_id == user.id
    ).first()
    if not thought:
        raise HTTPException(status_code=404, detail="Thought not found")
        
    links = db.query(ThoughtLink).filter(
        (ThoughtLink.source_id == thought_id) | (ThoughtLink.target_id == thought_id)
    ).all()
    
    res = thought.to_dict()
    res["links"] = [link.to_dict() for link in links]
    return res


@app.post("/api/thoughts/{thought_id}/process")
def reprocess_thought(
    thought_id: int,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    thought = db.query(Thought).filter(
        Thought.id == thought_id,
        Thought.user_id == user.id
    ).first()
    if not thought:
        raise HTTPException(status_code=404, detail="Thought not found")
        
    thought.processed = False
    db.commit()
    
    background_tasks.add_task(enrich_thought_task, thought_id)
    return {"status": "processing_scheduled"}


@app.delete("/api/thoughts/{thought_id}")
def delete_thought(
    thought_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    thought = db.query(Thought).filter(
        Thought.id == thought_id,
        Thought.user_id == user.id
    ).first()
    if not thought:
        raise HTTPException(status_code=404, detail="Thought not found")
        
    try:
        db.delete(thought)
        db.commit()
        return {"status": "deleted"}
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to delete thought {thought_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/graph")
def get_graph(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Returns graph coordinates nodes and edge lines for visualization (scoped to the user).
    """
    thoughts = db.query(Thought).filter(Thought.user_id == user.id).all()
    thought_ids = [t.id for t in thoughts]
    
    links = db.query(ThoughtLink).filter(
        ThoughtLink.source_id.in_(thought_ids),
        ThoughtLink.target_id.in_(thought_ids)
    ).all()
    
    nodes = []
    for t in thoughts:
        nodes.append({
            "id": t.id,
            "label": t.content[:20] + "..." if len(t.content) > 20 else t.content,
            "category": t.category or "General",
            "date": t.created_at.strftime("%Y-%m-%d"),
            "size": 10 + min(20, len(t.content) // 50)
        })
        
    edges = []
    for l in links:
        edges.append({
            "id": l.id,
            "source": l.source_id,
            "target": l.target_id,
            "similarity": l.similarity_score,
            "description": l.description
        })
        
    return {"nodes": nodes, "edges": edges}

# ----------------------------------------------------
# Static Assets Routing & Frontend Views
# ----------------------------------------------------

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def serve_index():
    return FileResponse("static/index.html")
