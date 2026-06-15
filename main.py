import os
import re
import datetime
import logging
import ipaddress
import threading
from typing import Optional, List
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks, Request, Response
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
import config
import database
from database import get_db, User, UserSession, Thought, ThoughtLink, WebReference, verify_pin, hash_pin

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Concurrency guard for background thought enrichment task
processing_thoughts = set()
processing_thoughts_lock = threading.Lock()


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

def is_private_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False

def verify_local_network_access(request: Request):
    # 1. Check proxy or Cloudflare headers first
    for header in ["cf-connecting-ip", "x-forwarded-for"]:
        val = request.headers.get(header)
        if val:
            client_ip = val.split(",")[0].strip()
            if not is_private_ip(client_ip):
                raise HTTPException(status_code=403, detail="Forbidden: Admin access allowed only from local network.")
                
    # 2. Check direct connection IP
    client_host = request.client.host if request.client else ""
    if client_host:
        if not is_private_ip(client_host):
            raise HTTPException(status_code=403, detail="Forbidden: Admin access allowed only from local network.")

# Directories
UPLOAD_DIR = config.DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Pydantic schemas
class LoginRequest(BaseModel):
    pin: str
    remember: bool = False

class SettingsUpdateRequest(BaseModel):
    pin: Optional[str] = None
    theme: Optional[str] = None
    location_enabled: Optional[bool] = None

class AdminUserCreate(BaseModel):
    username: str
    subdomain: Optional[str] = None
    pin: str

class AdminUserUpdate(BaseModel):
    username: Optional[str] = None
    subdomain: Optional[str] = None
    pin: Optional[str] = None

class ThoughtCreate(BaseModel):
    content: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None
    client_local_time: Optional[str] = None
    timezone_offset: Optional[int] = None

class ThoughtUpdate(BaseModel):
    content: str

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
    next_steps: Optional[str] = None
    is_todo: bool
    todo_done: bool
    is_reminder: bool
    reminder_at: Optional[str] = None
    reminder_sent: bool

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
    user = db.query(User).filter(
        (User.subdomain == username) |
        ((User.subdomain == None) & (User.username == username))
    ).first()
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
    user = db.query(User).filter(
        (User.subdomain == username) |
        ((User.subdomain == None) & (User.username == username))
    ).first()
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
        # Secure is dynamically enabled if running behind HTTPS (Cloudflare Tunnel)
        is_secure = request.headers.get("x-forwarded-proto") == "https" or "https" in request.headers.get("cf-visitor", "")
        response.set_cookie(
            key="session_token",
            value=session_token,
            httponly=True,
            secure=is_secure,
            samesite="lax",
            expires=expires_at.replace(tzinfo=datetime.timezone.utc)
        )
        
        return {"status": "success", "username": user.username, "theme": user.theme, "location_enabled": user.location_enabled, "ntfy_topic": config.NTFY_TOPIC}
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
    return {
        "authenticated": True, 
        "username": user.username, 
        "theme": user.theme, 
        "location_enabled": user.location_enabled,
        "ntfy_topic": config.NTFY_TOPIC
    }

@app.get("/api/log_error")
def log_error(msg: str):
    logger.warning(f"FRONTEND ERROR DETECTED: {msg}")
    return {"status": "logged"}

@app.post("/api/user/settings")
def update_settings(
    settings_in: SettingsUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if settings_in.theme is not None:
        user.theme = settings_in.theme
    if settings_in.location_enabled is not None:
        user.location_enabled = settings_in.location_enabled
    if settings_in.pin is not None:
        if len(settings_in.pin) != 4 or not settings_in.pin.isdigit():
            raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits.")
        hashed, salt = hash_pin(settings_in.pin)
        user.pin_hash = hashed
        user.pin_salt = salt
    db.commit()
    return {"status": "success", "theme": user.theme, "location_enabled": user.location_enabled}

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

def enrich_thought_task(
    thought_id: int,
    client_local_time: Optional[str] = None,
    timezone_offset: Optional[int] = None
):
    """
    Worker task to enrich a captured thought: categorizes, links, runs web crawls, and parses To-Dos/Reminders.
    """
    with processing_thoughts_lock:
        if thought_id in processing_thoughts:
            logger.info(f"Thought {thought_id} is already being enriched. Skipping duplicate execution.")
            return
        processing_thoughts.add(thought_id)

    from ai_service import AIService
    import datetime
    db = database.SessionLocal()
    try:
        thought = db.query(Thought).filter(Thought.id == thought_id).first()
        if not thought:
            logger.warning(f"Enrichment task failed: Thought {thought_id} not found in DB.")
            return

        if thought.processed:
            logger.info(f"Thought {thought_id} is already processed. Skipping.")
            return

        logger.info(f"Enriching thought {thought.id} for user {thought.user.username}...")
        
        # 0. Extract To-Do and Reminder configurations using LLM
        local_time_context = client_local_time or datetime.datetime.utcnow().isoformat()
        try:
            parsed_data = AIService.parse_todo_and_reminder(thought.content, local_time_context)
            thought.is_todo = parsed_data.get("is_todo", False)
            thought.is_reminder = parsed_data.get("is_reminder", False)
            
            # If categorized as "To-Do" by the custom categorizer, override is_todo to True
            # to remain consistent with category classifications
            
            reminder_at_str = parsed_data.get("reminder_at")
            if thought.is_reminder and reminder_at_str:
                # Naive local time parsing
                dt_local = datetime.datetime.fromisoformat(reminder_at_str.replace("Z", ""))
                if timezone_offset is not None:
                    # Client offset is in minutes (UTC - Local), so: UTC = Local + offset
                    dt_utc = dt_local + datetime.timedelta(minutes=timezone_offset)
                else:
                    dt_utc = dt_local
                thought.reminder_at = dt_utc
                thought.reminder_sent = False
        except Exception as e:
            logger.error(f"Failed to parse and extract task/reminder metadata for thought {thought.id}: {e}")
            
        # 1. Auto Categorize
        category = AIService.categorize_thought(thought.content)
        if category.startswith("[LLM generation failed"):
            raise RuntimeError(f"Categorization failed: {category}")
        thought.category = category
        
        # 2. Summary & Thematic description
        summary = AIService.analyze_and_summarize(thought.content)
        if summary.startswith("[LLM generation failed"):
            raise RuntimeError(f"Summary generation failed: {summary}")
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
                    
        # Flush DB to make sure new web references are queryable
        db.flush()
        
        # 3b. Next steps expansion
        web_refs = db.query(WebReference).filter(WebReference.thought_id == thought.id).all()
        next_steps = AIService.generate_next_steps(
            content=thought.content,
            category=category,
            summary=summary,
            web_references=[{"title": r.title, "url": r.url, "snippet": r.snippet} for r in web_refs[:2]]
        )
        if next_steps.startswith("[LLM generation failed"):
            raise RuntimeError(f"Next steps generation failed: {next_steps}")
        thought.next_steps = next_steps
                    
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
        with processing_thoughts_lock:
            processing_thoughts.discard(thought_id)

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
        
        background_tasks.add_task(
            enrich_thought_task, 
            thought.id, 
            thought_in.client_local_time, 
            thought_in.timezone_offset
        )
        return thought.to_dict()
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to create thought: {e}")
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


@app.get("/api/thoughts/{thought_id}/next_steps")
def get_thought_next_steps(
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
        
    # If the thought is not processed yet, return a pending message immediately without calling the LLM
    if not thought.processed:
        return {"next_steps": "AI model deep enrichment in progress..."}


    # If already successfully generated, return immediately
    if thought.next_steps and not thought.next_steps.startswith("[LLM generation failed"):
        return {"next_steps": thought.next_steps}
        
    # Otherwise, generate next steps dynamically

    from ai_service import AIService
    web_refs = db.query(WebReference).filter(WebReference.thought_id == thought.id).all()
    try:
        next_steps = AIService.generate_next_steps(
            content=thought.content,
            category=thought.category or "General",
            summary=thought.enrichment_summary or "",
            web_references=[{"title": r.title, "url": r.url, "snippet": r.snippet} for r in web_refs[:2]]
        )
        if next_steps and not next_steps.startswith("[LLM generation failed"):
            thought.next_steps = next_steps
            db.commit()
        return {"next_steps": next_steps}
    except Exception as e:
        logger.error(f"Failed dynamic next steps generation: {e}")
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")


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


@app.put("/api/thoughts/{thought_id}")
def update_thought(
    thought_id: int,
    thought_in: ThoughtUpdate,
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
        
    thought.content = thought_in.content
    thought.processed = False
    
    # Clear old next steps, summary, web references, and links to allow clean re-processing
    thought.next_steps = None
    thought.enrichment_summary = None
    db.query(WebReference).filter(WebReference.thought_id == thought.id).delete()
    db.query(ThoughtLink).filter((ThoughtLink.source_id == thought.id) | (ThoughtLink.target_id == thought.id)).delete()
    
    db.commit()
    
    background_tasks.add_task(enrich_thought_task, thought_id)
    return {"status": "updated_and_processing"}


@app.put("/api/thoughts/{thought_id}/todo")
def toggle_todo_status(
    thought_id: int,
    todo_done: bool,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    thought = db.query(Thought).filter(
        Thought.id == thought_id,
        Thought.user_id == user.id
    ).first()
    if not thought:
        raise HTTPException(status_code=404, detail="Thought not found")
        
    thought.todo_done = todo_done
    db.commit()
    return {"status": "success", "id": thought.id, "todo_done": thought.todo_done}


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
# Administrative Interfaces (LAN Restricted)
# ----------------------------------------------------

@app.get("/admin", response_class=HTMLResponse)
def serve_admin(request: Request):
    verify_local_network_access(request)
    return FileResponse("static/admin.html")

@app.get("/api/admin/users")
def get_admin_users(request: Request, db: Session = Depends(get_db)):
    verify_local_network_access(request)
    users = db.query(User).all()
    res = []
    for u in users:
        thought_count = db.query(Thought).filter(Thought.user_id == u.id).count()
        last_thought = db.query(Thought).filter(Thought.user_id == u.id).order_by(Thought.created_at.desc()).first()
        last_thought_at = last_thought.created_at.isoformat() + "Z" if last_thought else None
        
        res.append({
            "id": u.id,
            "username": u.username,
            "subdomain": u.subdomain or u.username,
            "failed_attempts": u.failed_attempts,
            "lockout_until": u.lockout_until.isoformat() + "Z" if u.lockout_until else None,
            "thought_count": thought_count,
            "last_thought_at": last_thought_at
        })
    return res

@app.post("/api/admin/users")
def create_admin_user(request: Request, user_in: AdminUserCreate, db: Session = Depends(get_db)):
    verify_local_network_access(request)
    
    existing_user = db.query(User).filter(User.username == user_in.username).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already exists.")
        
    sub = user_in.subdomain or user_in.username
    existing_sub = db.query(User).filter(User.subdomain == sub).first()
    if existing_sub:
        raise HTTPException(status_code=400, detail="Subdomain already mapped to another user.")
        
    hashed, salt = database.hash_pin(user_in.pin)
    new_user = User(
        username=user_in.username,
        subdomain=sub,
        pin_hash=hashed,
        pin_salt=salt
    )
    db.add(new_user)
    db.commit()
    return {"status": "success", "username": new_user.username}

@app.put("/api/admin/users/{user_id}")
def update_admin_user(request: Request, user_id: int, user_in: AdminUserUpdate, db: Session = Depends(get_db)):
    verify_local_network_access(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
        
    if user_in.username:
        conflict = db.query(User).filter(User.username == user_in.username, User.id != user_id).first()
        if conflict:
            raise HTTPException(status_code=400, detail="Username already exists.")
        user.username = user_in.username
        
    if user_in.subdomain:
        conflict = db.query(User).filter(User.subdomain == user_in.subdomain, User.id != user_id).first()
        if conflict:
            raise HTTPException(status_code=400, detail="Subdomain already mapped to another user.")
        user.subdomain = user_in.subdomain
        
    if user_in.pin:
        hashed, salt = database.hash_pin(user_in.pin)
        user.pin_hash = hashed
        user.pin_salt = salt
        
    db.commit()
    return {"status": "success"}

@app.post("/api/admin/users/{user_id}/unlock")
def unlock_admin_user(request: Request, user_id: int, db: Session = Depends(get_db)):
    verify_local_network_access(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    user.failed_attempts = 0
    user.lockout_until = None
    db.commit()
    return {"status": "success"}

@app.delete("/api/admin/users/{user_id}")
def delete_admin_user(request: Request, user_id: int, db: Session = Depends(get_db)):
    verify_local_network_access(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
        
    db.delete(user)
    db.commit()
    return {"status": "success"}

# ----------------------------------------------------
# Static Assets Routing & Frontend Views
# ----------------------------------------------------

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
def serve_index():
    return FileResponse("static/index.html")
