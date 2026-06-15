import datetime
import os
import hashlib
from sqlalchemy import create_engine, Column, Integer, String, Text, Float, Boolean, DateTime, ForeignKey, text
from sqlalchemy.orm import declarative_base, sessionmaker, relationship
from config import DATABASE_URL

# Create database engine
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Declarative base class for models
Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    subdomain = Column(String, unique=True, index=True, nullable=True)
    pin_hash = Column(String, nullable=False)
    pin_salt = Column(String, nullable=False)
    failed_attempts = Column(Integer, default=0)
    lockout_until = Column(DateTime, nullable=True)
    theme = Column(String, default="default", nullable=False)
    location_enabled = Column(Boolean, default=False, nullable=False)
    
    # Relationships
    thoughts = relationship("Thought", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "failed_attempts": self.failed_attempts,
            "lockout_until": self.lockout_until.isoformat() + "Z" if self.lockout_until else None
        }

class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_token = Column(String, unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    is_trusted = Column(Boolean, default=False)
    
    # Relationships
    user = relationship("User", back_populates="sessions")

    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "session_token": self.session_token,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
            "expires_at": self.expires_at.isoformat() + "Z" if self.expires_at else None,
            "is_trusted": self.is_trusted
        }

class Thought(Base):
    __tablename__ = "thoughts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    
    # Geolocation fields
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    location_name = Column(String, nullable=True)
    
    # Enrichment fields
    category = Column(String, nullable=True, index=True)
    processed = Column(Boolean, default=False, index=True)
    enrichment_summary = Column(Text, nullable=True)
    next_steps = Column(Text, nullable=True)
    
    # Relationships
    user = relationship("User", back_populates="thoughts")
    web_references = relationship("WebReference", back_populates="thought", cascade="all, delete-orphan")
    
    def to_dict(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "content": self.content,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "location_name": self.location_name,
            "category": self.category,
            "processed": self.processed,
            "enrichment_summary": self.enrichment_summary,
            "next_steps": self.next_steps,
            "web_references": [ref.to_dict() for ref in self.web_references]
        }

class ThoughtLink(Base):
    __tablename__ = "thought_links"

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(Integer, ForeignKey("thoughts.id", ondelete="CASCADE"), nullable=False)
    target_id = Column(Integer, ForeignKey("thoughts.id", ondelete="CASCADE"), nullable=False)
    relationship_type = Column(String, default="thematic")
    similarity_score = Column(Float, nullable=True)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships to access actual thought objects
    source_thought = relationship("Thought", foreign_keys=[source_id])
    target_thought = relationship("Thought", foreign_keys=[target_id])

    def to_dict(self):
        return {
            "id": self.id,
            "source_id": self.source_id,
            "target_id": self.target_id,
            "relationship_type": self.relationship_type,
            "similarity_score": self.similarity_score,
            "description": self.description,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None
        }

class WebReference(Base):
    __tablename__ = "web_references"

    id = Column(Integer, primary_key=True, index=True)
    thought_id = Column(Integer, ForeignKey("thoughts.id", ondelete="CASCADE"), nullable=False)
    url = Column(String, nullable=False)
    title = Column(String, nullable=True)
    snippet = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Back relationship
    thought = relationship("Thought", back_populates="web_references")

    def to_dict(self):
        return {
            "id": self.id,
            "thought_id": self.thought_id,
            "url": self.url,
            "title": self.title,
            "snippet": self.snippet,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None
        }

# PIN hashing functions using PBKDF2 with SHA-256
def hash_pin(pin: str, salt: str = None) -> tuple:
    if not salt:
        salt = os.urandom(16).hex()
    key = hashlib.pbkdf2_hmac(
        "sha256",
        pin.encode("utf-8"),
        salt.encode("utf-8"),
        100000  # 100k iterations for PBKDF2
    )
    return key.hex(), salt

def verify_pin(pin: str, salt: str, pin_hash: str) -> bool:
    hashed, _ = hash_pin(pin, salt)
    return hashed == pin_hash

# Dependency helper to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Helper to initialize database and tables
def init_db():
    Base.metadata.create_all(bind=engine)
    # Programmatically add subdomain column if it doesn't exist (since SQLite metadata doesn't do migration)
    db = SessionLocal()
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN subdomain TEXT"))
        db.commit()
        # Set default values: subdomain = username
        db.execute(text("UPDATE users SET subdomain = username"))
        db.commit()
        print("Database migrated: added 'subdomain' column to 'users' table.")
    except Exception as e:
        # Column already exists, ignore
        pass

    # Programmatically add theme column if it doesn't exist
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'default'"))
        db.commit()
        db.execute(text("UPDATE users SET theme = 'default' WHERE theme IS NULL"))
        db.commit()
        print("Database migrated: added 'theme' column to 'users' table.")
    except Exception as e:
        # Column already exists or failed, ignore
        pass

    # Programmatically add location_enabled column if it doesn't exist
    try:
        db.execute(text("ALTER TABLE users ADD COLUMN location_enabled BOOLEAN DEFAULT 0"))
        db.commit()
        db.execute(text("UPDATE users SET location_enabled = 0 WHERE location_enabled IS NULL"))
        db.commit()
        print("Database migrated: added 'location_enabled' column to 'users' table.")
    except Exception as e:
        # Column already exists or failed, ignore
        pass

    # Programmatically add next_steps column if it doesn't exist
    try:
        db.execute(text("ALTER TABLE thoughts ADD COLUMN next_steps TEXT"))
        db.commit()
        print("Database migrated: added 'next_steps' column to 'thoughts' table.")
    except Exception as e:
        # Column already exists or failed, ignore
        pass
    finally:
        db.close()

if __name__ == "__main__":
    print("Initializing SQLite Database...")
    init_db()
    print("Database tables created successfully.")
