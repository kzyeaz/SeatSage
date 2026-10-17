import time
import uuid

import httpx

from . import config


class BookingError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def seat_view(row, now, user_hold_ids):
    status = "sold" if row["order_id"] else (
        "held" if row["hold_id"] and row["hold_expires_at"] > now else "available"
    )
    return {
        "id": row["seat_id"], "row": row["row_label"], "number": row["seat_number"],
        "section": row["section"], "price_cents": row["price_cents"], "status": status,
        "is_mine": status == "held" and row["hold_id"] in user_hold_ids,
    }


def order_view(db, order):
    return {
        **order,
        "seats": db.all(
            "SELECT seat_id AS id, section, price_cents FROM order_items WHERE order_id=? ORDER BY seat_id",
            (order["id"],),
        ),
    }


class LocalInventory:
    """SQLite demo adapter. BEGIN IMMEDIATE serializes writers, not PG row locks."""

    def __init__(self, database, ttl=None, clock=time.time):
        self.database = database
        self.ttl = ttl if ttl is not None else config.HOLD_TTL_SECONDS
        self.clock = clock

    def seats(self, event_id, user_id):
        now = int(self.clock())
        with self.database.connect() as db:
            rows = db.all(
                "SELECT * FROM event_seats WHERE event_id=? ORDER BY row_label,seat_number",
                (event_id,),
            )
            if not rows:
                raise BookingError(404, "Event not found.")
            mine = {r["id"] for r in db.all(
                "SELECT id FROM holds WHERE user_id=? AND state='active' AND expires_at>?",
                (user_id, now),
            )}
            return {"seats": [seat_view(r, now, mine) for r in rows], "server_time": now}

    def hold(self, event_id, seat_ids, user_id):
        if not 1 <= len(seat_ids) <= 6 or len(set(seat_ids)) != len(seat_ids):
            raise BookingError(422, "Choose between one and six different seats.")
        with self.database.connect(write=True) as db:
            now = int(self.clock())
            rows = db.all(
                f"SELECT * FROM event_seats WHERE event_id=? AND seat_id IN ({','.join('?' for _ in seat_ids)})",
                (event_id, *seat_ids),
            )
            if len(rows) != len(seat_ids):
                raise BookingError(404, "One or more seats do not exist.")
            if any(r["order_id"] or (r["hold_id"] and r["hold_expires_at"] > now) for r in rows):
                raise BookingError(409, "Someone just grabbed one of those seats. Choose another spot.")
            hold_id = str(uuid.uuid4())
            expires = now + self.ttl
            db.execute(
                "INSERT INTO holds (id,user_id,event_id,expires_at,state,created_at) VALUES (?,?,?,?,'active',?)",
                (hold_id, user_id, event_id, expires, now),
            )
            for seat in rows:
                db.execute(
                    "INSERT INTO hold_items (hold_id,event_id,seat_id,price_cents) VALUES (?,?,?,?)",
                    (hold_id, event_id, seat["seat_id"], seat["price_cents"]),
                )
                db.execute(
                    "UPDATE event_seats SET hold_id=?,hold_expires_at=? WHERE event_id=? AND seat_id=?",
                    (hold_id, expires, event_id, seat["seat_id"]),
                )
            return {
                "id": hold_id, "event_id": event_id, "expires_at": expires, "server_time": now,
                "seat_ids": sorted(seat_ids), "subtotal_cents": sum(r["price_cents"] for r in rows),
            }

    def release(self, hold_id, user_id):
        with self.database.connect(write=True) as db:
            hold = db.one("SELECT * FROM holds WHERE id=? AND user_id=?", (hold_id, user_id))
            if not hold:
                raise BookingError(404, "Hold not found.")
            if hold["state"] == "active":
                db.execute("UPDATE holds SET state='released' WHERE id=?", (hold_id,))
                db.execute(
                    "UPDATE event_seats SET hold_id=NULL,hold_expires_at=NULL WHERE hold_id=? AND order_id IS NULL",
                    (hold_id,),
                )
        return {"released": True}

    def checkout(self, hold_id, user_id, idempotency_key):
        with self.database.connect(write=True) as db:
            existing = db.one(
                "SELECT * FROM orders WHERE user_id=? AND idempotency_key=?", (user_id, idempotency_key)
            )
            if existing:
                if existing["hold_id"] != hold_id:
                    raise BookingError(409, "This checkout key was already used for a different hold.")
                return order_view(db, existing)
            now = int(self.clock())
            hold = db.one("SELECT * FROM holds WHERE id=? AND user_id=?", (hold_id, user_id))
            if not hold:
                raise BookingError(404, "Hold not found.")
            if hold["state"] != "active" or hold["expires_at"] <= now:
                raise BookingError(409, "Your hold has expired or was already checked out. Please choose seats again.")
            rows = db.all(
                """SELECT s.* FROM event_seats s JOIN hold_items h
                ON s.event_id=h.event_id AND s.seat_id=h.seat_id WHERE h.hold_id=? ORDER BY s.seat_id""",
                (hold_id,),
            )
            if not rows or any(
                r["order_id"] or r["hold_id"] != hold_id or r["hold_expires_at"] <= now for r in rows
            ):
                raise BookingError(409, "These seats are no longer held for you.")
            subtotal = sum(r["price_cents"] for r in rows)
            fee = (subtotal * 8 + 50) // 100
            order_id = "SS-" + uuid.uuid4().hex[:12].upper()
            db.execute(
                """INSERT INTO orders
                (id,user_id,event_id,hold_id,idempotency_key,subtotal_cents,fee_cents,total_cents,created_at)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (order_id, user_id, hold["event_id"], hold_id, idempotency_key, subtotal, fee, subtotal + fee, now),
            )
            for seat in rows:
                db.execute(
                    "INSERT INTO order_items (order_id,event_id,seat_id,section,price_cents) VALUES (?,?,?,?,?)",
                    (order_id, hold["event_id"], seat["seat_id"], seat["section"], seat["price_cents"]),
                )
                db.execute(
                    "UPDATE event_seats SET order_id=?,hold_id=NULL,hold_expires_at=NULL WHERE event_id=? AND seat_id=?",
                    (order_id, hold["event_id"], seat["seat_id"]),
                )
            db.execute("UPDATE holds SET state='consumed' WHERE id=?", (hold_id,))
            return order_view(db, db.one("SELECT * FROM orders WHERE id=?", (order_id,)))


class RemoteInventory:
    def __init__(self):
        self.client = httpx.Client(
            base_url=config.INVENTORY_URL, timeout=15,
            headers={"X-Inventory-Token": config.INVENTORY_TOKEN},
        )

    def request(self, method, path, **kwargs):
        try:
            response = self.client.request(method, path, **kwargs)
        except httpx.RequestError as exc:
            raise BookingError(503, "Inventory is temporarily unavailable. Please try again.") from exc
        if response.is_error:
            try:
                message = response.json().get("detail", "Inventory request failed.")
            except ValueError:
                message = "Inventory request failed."
            raise BookingError(response.status_code, message)
        return response.json()

    def seats(self, event_id, user_id):
        return self.request("GET", f"/inventory/events/{event_id}/seats", params={"user_id": user_id})

    def hold(self, event_id, seat_ids, user_id):
        return self.request("POST", "/inventory/holds", json={
            "event_id": event_id, "seat_ids": seat_ids, "user_id": user_id,
        })

    def release(self, hold_id, user_id):
        return self.request("DELETE", f"/inventory/holds/{hold_id}", params={"user_id": user_id})

    def checkout(self, hold_id, user_id, idempotency_key):
        return self.request("POST", "/inventory/checkout", json={
            "hold_id": hold_id, "user_id": user_id, "idempotency_key": idempotency_key,
        })
