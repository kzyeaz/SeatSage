"""Create fresh synthetic inventory, without overwriting existing demo data.

docker compose exec -T api python - < load/prepare.py
"""

import os
import time
from datetime import datetime, timedelta, timezone

import psycopg

event_id = os.getenv("LOAD_EVENT_ID", "load-arena")
count = int(os.getenv("LOAD_SEAT_COUNT", "100000"))
if not event_id.startswith("load-") or not 1000 <= count <= 1000000:
    raise SystemExit("Use an event ID starting with load- and 1,000–1,000,000 seats.")

with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
    if conn.execute("SELECT 1 FROM events WHERE id=%s", (event_id,)).fetchone():
        raise SystemExit(f"{event_id} already exists. Use a new LOAD_EVENT_ID for fresh stock.")
    conn.execute(
        """INSERT INTO events
        (id,title,category,city,venue,starts_at,image,accent,description,tags,organizer_id,created_at)
        VALUES (%s,%s,'Load test','New York','Synthetic arena',%s,'','#c3ff73',
        'Synthetic inventory for isolated load testing.','[]','load-test',%s)""",
        (event_id, f"Load fixture: {event_id}", (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(), int(time.time())),
    )
    conn.execute(
        """INSERT INTO event_seats(event_id,seat_id,section,row_label,seat_number,price_cents)
        SELECT %s, 'L' || LPAD(n::text,7,'0'), 'Load test', 'L', n, 1000
        FROM generate_series(1,%s) n""", (event_id, count),
    )
print(f"Prepared {event_id}: {count:,} synthetic seats.")
