-- All four result sets must be empty after a contention run.
-- Run with:
-- docker compose exec -T postgres psql -U seatsage -d seatsage < load/audit.sql

-- No seat may appear on more than one order.
SELECT event_id, seat_id, COUNT(*) AS bookings
FROM order_items GROUP BY event_id, seat_id HAVING COUNT(*) > 1;

-- Each sold seat must have exactly the matching immutable order item.
SELECT s.event_id, s.seat_id, s.order_id, i.order_id AS item_order
FROM event_seats s LEFT JOIN order_items i
ON i.event_id = s.event_id AND i.seat_id = s.seat_id
WHERE (s.order_id IS NOT NULL AND (i.order_id IS NULL OR i.order_id <> s.order_id))
   OR (s.order_id IS NULL AND i.order_id IS NOT NULL);

-- Every consumed hold must have exactly one order.
SELECT h.id, COUNT(o.id)
FROM holds h LEFT JOIN orders o ON o.hold_id = h.id
WHERE h.state = 'consumed'
GROUP BY h.id HAVING COUNT(o.id) <> 1;

-- Order totals must match immutable item prices and the documented 8% fee.
SELECT o.id FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.subtotal_cents, o.fee_cents, o.total_cents
HAVING COUNT(i.seat_id) = 0
    OR o.subtotal_cents <> SUM(i.price_cents)
    OR o.fee_cents <> (o.subtotal_cents * 8 + 50) / 100
    OR o.total_cents <> o.subtotal_cents + o.fee_cents;
