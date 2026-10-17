import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field, field_validator

from . import config
from .db import Database
from .inventory import BookingError, LocalInventory, RemoteInventory, order_view
from .search import SearchIndex
from .seed import insert_event, seed

log = logging.getLogger(__name__)
database = Database()
inventory = RemoteInventory() if config.APP_MODE == "distributed" else LocalInventory(database)
search = SearchIndex()
signer = URLSafeTimedSerializer(config.SESSION_SECRET, salt="seatsage-demo")


@asynccontextmanager
async def lifespan(app):
    if config.APP_MODE == "distributed" and not config.DATABASE_URL:
        raise RuntimeError("Distributed mode requires DATABASE_URL.")
    database.initialize()
    seed(database)
    event_summary.cache_clear()
    with database.connect() as db:
        search.index(db.all("SELECT * FROM events"))
    yield
    if isinstance(inventory, RemoteInventory):
        inventory.client.close()


app = FastAPI(
    title="SeatSage Marketplace API", version="1.0.0",
    description="Demo event marketplace. Checkout is simulated; no real payment is collected.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware, allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True, allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "Idempotency-Key"],
)


@app.middleware("http")
async def request_context(request, call_next):
    request_id = str(uuid.uuid4())
    origin = request.headers.get("origin")
    if request.method in {"POST", "DELETE", "PUT", "PATCH"} and origin and origin not in config.ALLOWED_ORIGINS:
        return JSONResponse({"detail": "Origin not allowed."}, status_code=403)
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["Cache-Control"] = "no-store"
    log.info("%s %s %s %.1fms request_id=%s", request.method, request.url.path,
             response.status_code, (time.perf_counter() - start) * 1000, request_id)
    return response


@app.exception_handler(BookingError)
async def booking_error(request, exc):
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


def session(request: Request):
    token = request.cookies.get("seatsage_session")
    try:
        user = signer.loads(token or "", max_age=86400 * 7)
        if user.get("role") not in ("attendee", "organizer"):
            raise BadSignature("Invalid role")
        return user
    except BadSignature:
        raise HTTPException(401, "Start a demo session to continue.")


def organizer(user=Depends(session)):
    if user["role"] != "organizer":
        raise HTTPException(403, "Switch to the organizer demo to access this view.")
    return user


class SessionInput(BaseModel):
    role: Literal["attendee", "organizer"] = "attendee"


@app.get("/api/v1/session")
def get_session(user=Depends(session)):
    return user


@app.post("/api/v1/demo/session")
def create_session(body: SessionInput, request: Request, response: Response):
    # Preserve the shopper identity when toggling the organizer demo.
    try:
        previous = signer.loads(request.cookies.get("seatsage_session", ""), max_age=86400 * 7)
        user_id = previous["id"]
    except (BadSignature, KeyError):
        user_id = "demo-" + uuid.uuid4().hex
    user = {"id": user_id, "name": "Alex Morgan", "role": body.role}
    response.set_cookie(
        "seatsage_session", signer.dumps(user), httponly=True, samesite="lax",
        secure=config.COOKIE_SECURE, max_age=86400 * 7,
    )
    return user


@app.get("/api/v1/health")
def health():
    with database.connect() as db:
        db.one("SELECT 1 AS ok")
    return {"status": "ok", "mode": config.APP_MODE, "payments": "simulated",
            "inventory": "go-postgresql-redis" if config.APP_MODE == "distributed" else "sqlite",
            "search": "elasticsearch" if search.ready else "sql"}


def event_view(db, row):
    stats = db.one(
        """SELECT MIN(price_cents) AS from_price_cents, COUNT(*) AS capacity,
        SUM(CASE WHEN order_id IS NULL AND (hold_id IS NULL OR hold_expires_at<=?) THEN 1 ELSE 0 END) AS available
        FROM event_seats WHERE event_id=?""", (int(time.time()), row["id"]),
    )
    return {**row, "tags": json.loads(row["tags"]), **stats}


@lru_cache(maxsize=256)
def event_summary(event_id):
    # Event metadata has no editing endpoint in this demo. Never cache availability
    # here: a receipt needs the event description, not a scan of all venue seats.
    with database.connect() as db:
        row = db.one("SELECT * FROM events WHERE id=?", (event_id,))
        if not row:
            raise HTTPException(404, "Event not found.")
        return {**row, "tags": json.loads(row["tags"])}


@app.get("/api/v1/events")
def events(
    q: str = Query("", max_length=160),
    category: str = Query("", max_length=40),
    city: str = Query("", max_length=80),
    sort: Literal["recommended", "date", "price"] = "recommended",
):
    query = q.strip()
    indexed = search.search(query) if query else None
    with database.connect() as db:
        rows = db.all("SELECT * FROM events ORDER BY featured DESC,starts_at")
        result = []
        for row in rows:
            if category and row["category"] != category:
                continue
            if city and row["city"] != city:
                continue
            if query:
                if indexed is not None:
                    if row["id"] not in indexed:
                        continue
                elif query.casefold() not in " ".join(
                    str(row[k]) for k in ("title", "description", "category", "city", "venue", "tags")
                ).casefold():
                    continue
            result.append(event_view(db, row))
    if sort == "date":
        result.sort(key=lambda e: e["starts_at"])
    elif sort == "price":
        result.sort(key=lambda e: e["from_price_cents"])
    elif indexed is not None:
        result.sort(key=lambda e: indexed.index(e["id"]))
    return {"items": result, "total": len(result), "search_engine": "elasticsearch" if indexed is not None else "sql"}


@app.get("/api/v1/events/{event_id}")
def event_detail(event_id: str):
    with database.connect() as db:
        row = db.one("SELECT * FROM events WHERE id=?", (event_id,))
        if not row:
            raise HTTPException(404, "Event not found.")
        return event_view(db, row)


@app.get("/api/v1/events/{event_id}/seats")
def seats(event_id: str, user=Depends(session)):
    return inventory.seats(event_id, user["id"])


class HoldInput(BaseModel):
    event_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9-]+$")
    seat_ids: list[str] = Field(min_length=1, max_length=6)

    @field_validator("seat_ids")
    @classmethod
    def validate_seats(cls, values):
        if len(values) != len(set(values)) or any(len(v) > 10 for v in values):
            raise ValueError("Select up to six distinct seat IDs.")
        return values


@app.post("/api/v1/holds", status_code=201)
def hold(body: HoldInput, user=Depends(session)):
    return inventory.hold(body.event_id, body.seat_ids, user["id"])


@app.delete("/api/v1/holds/{hold_id}")
def release(hold_id: str, user=Depends(session)):
    return inventory.release(hold_id, user["id"])


class CheckoutInput(BaseModel):
    hold_id: str = Field(min_length=1, max_length=100)


@app.post("/api/v1/checkout")
def checkout(
    body: CheckoutInput,
    idempotency_key: str = Header(min_length=8, max_length=100),
    user=Depends(session),
):
    order = inventory.checkout(body.hold_id, user["id"], idempotency_key)
    order["event"] = event_summary(order["event_id"])
    return order


@app.get("/api/v1/orders")
def orders(user=Depends(session)):
    with database.connect() as db:
        rows = db.all("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC", (user["id"],))
        result = []
        for row in rows:
            order = order_view(db, row)
            event = db.one("SELECT * FROM events WHERE id=?", (row["event_id"],))
            order["event"] = {**event, "tags": json.loads(event["tags"])}
            result.append(order)
    return {"items": result}


@app.get("/api/v1/organizer/dashboard")
def dashboard(user=Depends(organizer)):
    # All sample events belong to the shared organizer persona.
    with database.connect() as db:
        event_rows = db.all("SELECT * FROM events WHERE organizer_id=? ORDER BY starts_at", ("demo-organizer",))
        event_stats = []
        for row in event_rows:
            stats = db.one(
                """SELECT COUNT(*) AS tickets_sold, COALESCE(SUM(price_cents),0) AS revenue_cents
                FROM order_items WHERE event_id=?""", (row["id"],),
            )
            event_stats.append({**event_view(db, row), **stats})
        recent = db.all(
            """SELECT o.id,o.created_at,o.total_cents,e.title,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id) AS quantity
            FROM orders o JOIN events e ON e.id=o.event_id
            WHERE e.organizer_id=? ORDER BY o.created_at DESC LIMIT 8""", ("demo-organizer",),
        )
    return {
        "events": event_stats, "recent_orders": recent,
        "revenue_cents": sum(e["revenue_cents"] for e in event_stats),
        "tickets_sold": sum(e["tickets_sold"] for e in event_stats),
        "total_capacity": sum(e["capacity"] for e in event_stats),
    }


class EventInput(BaseModel):
    title: str = Field(min_length=3, max_length=100)
    category: Literal["Music", "Sports", "Theater", "Comedy"]
    city: Literal["New York", "Chicago", "Los Angeles"]
    venue: str = Field(min_length=3, max_length=100)
    starts_at: datetime
    description: str = Field(min_length=20, max_length=2000)
    base_price_cents: int = Field(ge=500, le=100000)

    @field_validator("starts_at")
    @classmethod
    def future_date(cls, value):
        if value.tzinfo is None or value <= datetime.now(timezone.utc):
            raise ValueError("Choose a future date with a timezone.")
        return value


@app.post("/api/v1/organizer/events", status_code=201)
def create_event(body: EventInput, user=Depends(organizer)):
    event_id = "event-" + uuid.uuid4().hex[:12]
    row = {
        "id": event_id, "title": body.title, "category": body.category,
        "city": body.city, "venue": body.venue, "starts_at": body.starts_at.isoformat(),
        "description": body.description,
        "image": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1000&q=85",
        "accent": "#c3ff73", "tags": json.dumps(["Live event", "New"]),
        "organizer_id": "demo-organizer", "featured": 0, "created_at": int(time.time()),
    }
    with database.connect(write=True) as db:
        insert_event(db, row, body.base_price_cents)
    with database.connect() as db:
        search.index(db.all("SELECT * FROM events"))
    return event_detail(event_id)
