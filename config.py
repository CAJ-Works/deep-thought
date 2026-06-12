import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

# System Directories
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Configurations
PORT = int(os.getenv("PORT", 8000))
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR}/deep_thought.db")
JWT_SECRET = os.getenv("JWT_SECRET", "deep_thought_secret_signing_key_change_me")

# LM Studio Local API
LM_STUDIO_BASE_URL = os.getenv("LM_STUDIO_BASE_URL", "http://host.docker.internal:1234/v1")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "")

# Gemini Cloud API
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
