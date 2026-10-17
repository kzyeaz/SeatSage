import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.inventory import BookingError, LocalInventory


def test_competing_buyers_get_exactly_one_hold(inventory, database):
    barrier = threading.Barrier(24)

    def compete(n):
        barrier.wait()
        try:
            return inventory.hold("afterglow", ["A1", "A2"], f"buyer-{n}")
        except BookingError as exc:
            assert exc.status == 409
            return None

    with ThreadPoolExecutor(max_workers=24) as pool:
        results = list(pool.map(compete, range(24)))
    winners = [result for result in results if result]
    assert len(winners) == 1
    with database.connect() as db:
        assert db.one("SELECT COUNT(*) AS n FROM holds")["n"] == 1
        assert db.one("SELECT COUNT(*) AS n FROM event_seats WHERE hold_id=?", (winners[0]["id"],))["n"] == 2


def test_parallel_checkout_retries_produce_one_order(inventory, database):
    hold = inventory.hold("afterglow", ["A1", "A2"], "buyer")
    barrier = threading.Barrier(16)

    def retry(_):
        barrier.wait()
        return inventory.checkout(hold["id"], "buyer", "stable-checkout-key")

    with ThreadPoolExecutor(max_workers=16) as pool:
        orders = list(pool.map(retry, range(16)))
    assert len({order["id"] for order in orders}) == 1
    assert orders[0]["total_cents"] == 22680
    with database.connect() as db:
        assert db.one("SELECT COUNT(*) AS n FROM orders")["n"] == 1
        assert db.one("SELECT COUNT(*) AS n FROM order_items")["n"] == 2
        assert db.one("SELECT COUNT(*) AS n FROM event_seats WHERE order_id IS NOT NULL")["n"] == 2


def test_group_reservation_is_atomic(inventory):
    inventory.hold("afterglow", ["A2"], "buyer-1")
    with pytest.raises(BookingError) as error:
        inventory.hold("afterglow", ["A1", "A2"], "buyer-2")
    assert error.value.status == 409
    assert next(s for s in inventory.seats("afterglow", "buyer-2")["seats"] if s["id"] == "A1")["status"] == "available"


def test_expiry_and_stale_release_cannot_steal_a_new_hold(database):
    now = [1000]
    inventory = LocalInventory(database, ttl=10, clock=lambda: now[0])
    old = inventory.hold("afterglow", ["B1"], "old-buyer")
    now[0] = 1010
    new = inventory.hold("afterglow", ["B1"], "new-buyer")
    with pytest.raises(BookingError) as error:
        inventory.checkout(old["id"], "old-buyer", "expired-key")
    assert error.value.status == 409
    inventory.release(old["id"], "old-buyer")
    order = inventory.checkout(new["id"], "new-buyer", "new-key-123")
    assert [seat["id"] for seat in order["seats"]] == ["B1"]


def test_ownership_and_idempotency_key_scope(inventory):
    first = inventory.hold("afterglow", ["A1"], "buyer")
    second = inventory.hold("afterglow", ["A2"], "buyer")
    for action in (
        lambda: inventory.release(first["id"], "stranger"),
        lambda: inventory.checkout(first["id"], "stranger", "stranger-key"),
    ):
        with pytest.raises(BookingError) as error:
            action()
        assert error.value.status == 404
    order = inventory.checkout(first["id"], "buyer", "same-key-123")
    assert inventory.checkout(first["id"], "buyer", "same-key-123")["id"] == order["id"]
    with pytest.raises(BookingError) as error:
        inventory.checkout(second["id"], "buyer", "same-key-123")
    assert error.value.status == 409
    with pytest.raises(BookingError):
        inventory.hold("afterglow", ["A1"], "another-buyer")


@pytest.mark.parametrize("seat_ids", [[], ["A1", "A1"], [f"A{i}" for i in range(1, 8)], ["Z99"]])
def test_invalid_selections_do_not_create_holds(inventory, database, seat_ids):
    with pytest.raises(BookingError):
        inventory.hold("afterglow", seat_ids, "buyer")
    with database.connect() as db:
        assert db.one("SELECT COUNT(*) AS n FROM holds")["n"] == 0


def test_api_session_booking_and_organizer_boundaries(database, inventory, monkeypatch):
    from app import main
    from app.search import SearchIndex

    monkeypatch.setattr(main, "database", database)
    monkeypatch.setattr(main, "inventory", inventory)
    index = SearchIndex()
    index.url = ""
    monkeypatch.setattr(main, "search", index)
    with TestClient(main.app) as client:
        assert client.get("/api/v1/orders").status_code == 401
        session = client.post("/api/v1/demo/session", json={"role": "attendee"}).json()
        assert client.get("/api/v1/organizer/dashboard").status_code == 403
        assert client.post("/api/v1/holds", json={"event_id": "afterglow", "seat_ids": ["A1", "A1"]}).status_code == 422
        hold = client.post("/api/v1/holds", json={"event_id": "afterglow", "seat_ids": ["A1"]}).json()
        order = client.post("/api/v1/checkout", json={"hold_id": hold["id"]}, headers={"Idempotency-Key": "test-key-123"}).json()
        assert order["event"]["id"] == "afterglow"
        assert len(client.get("/api/v1/orders").json()["items"]) == 1
        filtered = client.get("/api/v1/events", params={"category": "Music", "city": "Chicago"}).json()
        assert [event["id"] for event in filtered["items"]] == ["velvet-room"]
        organizer = client.post("/api/v1/demo/session", json={"role": "organizer"}).json()
        assert organizer["id"] == session["id"]
        assert client.get("/api/v1/organizer/dashboard").json()["tickets_sold"] == 1
        assert client.post("/api/v1/demo/session", headers={"Origin": "https://untrusted.example"}, json={"role": "attendee"}).status_code == 403
        client.cookies.set("seatsage_session", "tampered")
        assert client.get("/api/v1/orders").status_code == 401
