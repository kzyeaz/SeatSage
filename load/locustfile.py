"""Contention workload. Start against a fresh, isolated demo database."""

import os
import random
import uuid

from locust import HttpUser, between, task
from locust.exception import StopUser

EVENT_ID = os.getenv("LOAD_EVENT_ID", "afterglow")


class TicketBuyer(HttpUser):
    wait_time = between(0.05, 0.25)

    def on_start(self):
        response = self.client.post("/api/v1/demo/session", json={"role": "attendee"}, name="session")
        if response.status_code != 200:
            raise StopUser()

    @task
    def contend_for_seats(self):
        # A deliberately small shared pool creates races between buyers.
        seat_id = random.choice([f"{row}{n}" for row in "ABCDEF" for n in range(1, 13)])
        with self.client.post(
            "/api/v1/holds", json={"event_id": EVENT_ID, "seat_ids": [seat_id]},
            name="hold (contention)", catch_response=True,
        ) as response:
            if response.status_code == 409:
                response.request_meta["name"] = "hold conflict (expected)"
                response.success()  # Expected rejection of a competing buyer.
                return
            if response.status_code != 201:
                response.failure(f"Unexpected hold status {response.status_code}")
                return
            hold_id = response.json()["id"]
        # Most winners release, so a long run continues exercising real writes.
        # Some check out and retry, testing durable idempotency and eventual sell-out.
        if random.random() < 0.1:
            key = uuid.uuid4().hex
            payload = {"hold_id": hold_id}
            headers = {"Idempotency-Key": key}
            with self.client.post("/api/v1/checkout", json=payload, headers=headers,
                                  name="checkout", catch_response=True) as response:
                if response.status_code != 200:
                    response.failure(f"Checkout failed: {response.status_code}")
                    return
                order_id = response.json()["id"]
            with self.client.post("/api/v1/checkout", json=payload, headers=headers,
                                  name="checkout retry", catch_response=True) as response:
                if response.status_code != 200 or response.json().get("id") != order_id:
                    response.failure("Idempotent retry returned a different result")
        else:
            self.client.delete(f"/api/v1/holds/{hold_id}", name="release")


class CheckoutBuyer(HttpUser):
    """Throughput workload with synthetic stock prepared by prepare.py."""

    wait_time = between(0.1, 0.5)

    def on_start(self):
        response = self.client.post("/api/v1/demo/session", json={"role": "attendee"}, name="session")
        if response.status_code != 200:
            raise StopUser()

    @task
    def checkout(self):
        event_id = os.getenv("LOAD_EVENT_ID", "load-arena")
        count = int(os.getenv("LOAD_SEAT_COUNT", "100000"))
        seat_id = f"L{random.randint(1, count):07d}"
        with self.client.post(
            "/api/v1/holds", json={"event_id": event_id, "seat_ids": [seat_id]},
            name="hold acquired", catch_response=True, timeout=30,
        ) as response:
            if response.status_code == 409:
                response.request_meta["name"] = "hold conflict (expected)"
                response.success()
                return
            if response.status_code != 201:
                response.failure(f"Unexpected hold status {response.status_code}")
                return
            hold_id = response.json()["id"]
        key = uuid.uuid4().hex
        with self.client.post(
            "/api/v1/checkout", json={"hold_id": hold_id}, headers={"Idempotency-Key": key},
            name="checkout completed", catch_response=True, timeout=30,
        ) as response:
            if response.status_code != 200:
                response.failure(f"Unexpected checkout status {response.status_code}")
                return
            order_id = response.json()["id"]
        if random.random() < 0.1:
            with self.client.post(
                "/api/v1/checkout", json={"hold_id": hold_id}, headers={"Idempotency-Key": key},
                name="checkout idempotent retry", catch_response=True, timeout=30,
            ) as response:
                if response.status_code != 200 or response.json().get("id") != order_id:
                    response.failure("Idempotency invariant failed")
