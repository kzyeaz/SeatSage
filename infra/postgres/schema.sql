CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    city TEXT NOT NULL,
    venue TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    image TEXT NOT NULL,
    accent TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL,
    organizer_id TEXT NOT NULL,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS holds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES events(id),
    expires_at BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'released')),
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES events(id),
    hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id),
    idempotency_key TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
    fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
    total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
    created_at BIGINT NOT NULL,
    UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS event_seats (
    event_id TEXT NOT NULL REFERENCES events(id),
    seat_id TEXT NOT NULL,
    section TEXT NOT NULL,
    row_label TEXT NOT NULL,
    seat_number INTEGER NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    hold_id TEXT REFERENCES holds(id),
    hold_expires_at BIGINT,
    order_id TEXT REFERENCES orders(id),
    PRIMARY KEY (event_id, seat_id)
);

CREATE TABLE IF NOT EXISTS hold_items (
    hold_id TEXT NOT NULL REFERENCES holds(id),
    event_id TEXT NOT NULL,
    seat_id TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (hold_id, seat_id),
    FOREIGN KEY (event_id, seat_id) REFERENCES event_seats(event_id, seat_id)
);

CREATE TABLE IF NOT EXISTS order_items (
    order_id TEXT NOT NULL REFERENCES orders(id),
    event_id TEXT NOT NULL,
    seat_id TEXT NOT NULL,
    section TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (order_id, seat_id),
    UNIQUE (event_id, seat_id),
    FOREIGN KEY (event_id, seat_id) REFERENCES event_seats(event_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_seats_hold ON event_seats(hold_id);
CREATE INDEX IF NOT EXISTS idx_holds_user ON holds(user_id, expires_at);
