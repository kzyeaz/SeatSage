import json
import time
from datetime import datetime, timedelta, timezone


EVENTS = [
    {
        "id": "afterglow", "title": "Afterglow Music Festival", "category": "Music",
        "city": "New York", "venue": "Brooklyn Mirage",
        "image": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1600&q=85",
        "accent": "#c3ff73", "tags": ["Electronic", "Live music", "18+"], "base": 6500,
        "description": "One night. A thousand little moments. Step into an open-air world of electronic music, immersive light installations, and a lineup made for losing yourself on the dance floor. Doors open one hour before the first set.",
        "featured": 1, "days": 12,
    },
    {
        "id": "courtside", "title": "New York vs. Boston", "category": "Sports",
        "city": "New York", "venue": "Madison Square Garden",
        "image": "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=1000&q=85",
        "accent": "#ffb380", "tags": ["Basketball", "Rivalry night", "All ages"], "base": 8900,
        "description": "The rivalry returns to the Garden. Feel every play from your reserved seat as two iconic teams meet for an unforgettable night of basketball. Arrive early for warmups and the full arena experience.",
        "featured": 0, "days": 15,
    },
    {
        "id": "velvet-room", "title": "Jazz in the Velvet Room", "category": "Music",
        "city": "Chicago", "venue": "The Green Mill",
        "image": "https://images.unsplash.com/photo-1511192336575-5a79af67a629?auto=format&fit=crop&w=1000&q=85",
        "accent": "#d9baff", "tags": ["Jazz", "Intimate venue", "21+"], "base": 4200,
        "description": "An intimate evening of modern jazz, old favorites, and unexpected improvisation. Settle into the warm glow of the Velvet Room for two live sets from a stellar quartet.",
        "featured": 0, "days": 8,
    },
    {
        "id": "night-of-laughs", "title": "A Very Good Night of Comedy", "category": "Comedy",
        "city": "New York", "venue": "Beacon Theatre",
        "image": "https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=1000&q=85",
        "accent": "#ffd478", "tags": ["Stand-up", "Live show", "18+"], "base": 3500,
        "description": "Your group chat deserves a night out. Join a fresh lineup of sharp, surprising comics for an evening of stories, big laughs, and the occasional excellent bad joke.",
        "featured": 0, "days": 6,
    },
    {
        "id": "city-in-motion", "title": "The City in Motion", "category": "Theater",
        "city": "New York", "venue": "Lincoln Center",
        "image": "https://images.unsplash.com/photo-1503095396549-807759245b35?auto=format&fit=crop&w=1000&q=85",
        "accent": "#ff9cae", "tags": ["Dance", "Contemporary", "All ages"], "base": 5500,
        "description": "A bold contemporary performance about the places we live and the people we become. Movement, sound, and architectural light bring the city's hidden rhythms to life.",
        "featured": 0, "days": 19,
    },
    {
        "id": "golden-hour", "title": "Golden Hour Sessions", "category": "Music",
        "city": "Los Angeles", "venue": "The Greek Theatre",
        "image": "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=1000&q=85",
        "accent": "#ffc885", "tags": ["Indie", "Outdoor", "All ages"], "base": 4800,
        "description": "A soundtrack for the last light of the day. Discover your next favorite indie artists under the trees, with a sunset set and a headliner that takes you into the night.",
        "featured": 0, "days": 22,
    },
]


def insert_event(db, event, base_price):
    db.execute(
        """INSERT INTO events
        (id,title,category,city,venue,starts_at,image,accent,description,tags,organizer_id,featured,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
        tuple(event[k] for k in (
            "id", "title", "category", "city", "venue", "starts_at", "image", "accent",
            "description", "tags", "organizer_id", "featured", "created_at",
        )),
    )
    for row_index, row in enumerate("ABCDEF"):
        section = "Front row" if row_index < 2 else "Standard" if row_index < 4 else "Balcony"
        price = base_price + (4000 if row_index < 2 else 1500 if row_index < 4 else 0)
        for number in range(1, 13):
            db.execute(
                """INSERT INTO event_seats (event_id,seat_id,section,row_label,seat_number,price_cents)
                VALUES (?,?,?,?,?,?) ON CONFLICT (event_id,seat_id) DO NOTHING""",
                (event["id"], f"{row}{number}", section, row, number, price),
            )


def seed(database):
    with database.connect(write=True) as db:
        for source in EVENTS:
            event = dict(source)
            # Dates are set once on first seed, rather than moving on every restart.
            date = datetime.now(timezone.utc).replace(hour=23, minute=0, second=0, microsecond=0)
            event.update(
                starts_at=(date + timedelta(days=event["days"])).isoformat(),
                organizer_id="demo-organizer",
                tags=json.dumps(event["tags"]),
                created_at=int(time.time()),
            )
            insert_event(db, event, event["base"])
