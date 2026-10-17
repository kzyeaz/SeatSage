import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

APP_MODE = os.getenv("APP_MODE", "local")
DATABASE_URL = os.getenv("DATABASE_URL", "")
DATABASE_PATH = os.getenv("DATABASE_PATH", str(ROOT / "data" / "seatsage.db"))
SESSION_SECRET = os.getenv("SESSION_SECRET", "seatsage-local-demo-only")
INVENTORY_URL = os.getenv("INVENTORY_URL", "http://localhost:8081")
INVENTORY_TOKEN = os.getenv("INVENTORY_TOKEN", "local-inventory-change-me")
ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "")
HOLD_TTL_SECONDS = max(10, min(900, int(os.getenv("HOLD_TTL_SECONDS", "300"))))
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080",
).split(",")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
