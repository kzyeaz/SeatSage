package booking

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

type Store struct {
	DB    *pgxpool.Pool
	Redis *redis.Client
	TTL   time.Duration
}

type Seat struct {
	ID         string `json:"id"`
	Row        string `json:"row"`
	Number     int    `json:"number"`
	Section    string `json:"section"`
	PriceCents int    `json:"price_cents"`
	Status     string `json:"status"`
	IsMine     bool   `json:"is_mine"`
}

type Hold struct {
	ID            string   `json:"id"`
	EventID       string   `json:"event_id"`
	ExpiresAt     int64    `json:"expires_at"`
	ServerTime    int64    `json:"server_time"`
	SeatIDs       []string `json:"seat_ids"`
	SubtotalCents int      `json:"subtotal_cents"`
}

type OrderSeat struct {
	ID         string `json:"id"`
	Section    string `json:"section"`
	PriceCents int    `json:"price_cents"`
}

type Order struct {
	ID             string      `json:"id"`
	UserID         string      `json:"user_id"`
	EventID        string      `json:"event_id"`
	HoldID         string      `json:"hold_id"`
	IdempotencyKey string      `json:"idempotency_key"`
	SubtotalCents  int         `json:"subtotal_cents"`
	FeeCents       int         `json:"fee_cents"`
	TotalCents     int         `json:"total_cents"`
	CreatedAt      int64       `json:"created_at"`
	Seats          []OrderSeat `json:"seats"`
}

func (s *Store) Seats(ctx context.Context, eventID, userID string) ([]Seat, error) {
	rows, err := s.DB.Query(ctx, `
		SELECT s.seat_id,s.row_label,s.seat_number,s.section,s.price_cents,
		CASE WHEN s.order_id IS NOT NULL THEN 'sold'
		     WHEN s.hold_id IS NOT NULL AND s.hold_expires_at>$2 THEN 'held'
		     ELSE 'available' END,
		COALESCE(s.order_id IS NULL AND s.hold_expires_at>$2 AND h.user_id=$3,false)
		FROM event_seats s LEFT JOIN holds h ON h.id=s.hold_id
		WHERE s.event_id=$1 ORDER BY s.row_label,s.seat_number`, eventID, time.Now().Unix(), userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seats := []Seat{}
	for rows.Next() {
		var seat Seat
		if err := rows.Scan(&seat.ID, &seat.Row, &seat.Number, &seat.Section, &seat.PriceCents, &seat.Status, &seat.IsMine); err != nil {
			return nil, err
		}
		seats = append(seats, seat)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(seats) == 0 {
		return nil, &Error{404, "Event not found."}
	}
	return seats, nil
}

type lockedSeat struct {
	OrderSeat
	HoldID    *string
	ExpiresAt *int64
	OrderID   *string
}

func lockSeats(ctx context.Context, tx pgx.Tx, eventID string, ids []string) ([]lockedSeat, error) {
	// Deterministic lock ordering avoids cycles when groups of seats overlap.
	rows, err := tx.Query(ctx, `
		SELECT seat_id,section,price_cents,hold_id,hold_expires_at,order_id
		FROM event_seats WHERE event_id=$1 AND seat_id=ANY($2)
		ORDER BY seat_id FOR UPDATE`, eventID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seats := []lockedSeat{}
	for rows.Next() {
		var seat lockedSeat
		if err := rows.Scan(&seat.ID, &seat.Section, &seat.PriceCents, &seat.HoldID, &seat.ExpiresAt, &seat.OrderID); err != nil {
			return nil, err
		}
		seats = append(seats, seat)
	}
	return seats, rows.Err()
}

func (s *Store) CreateHold(ctx context.Context, eventID string, ids []string, userID string) (*Hold, error) {
	if len(ids) < 1 || len(ids) > 6 || userID == "" || eventID == "" {
		return nil, &Error{422, "Choose between one and six seats."}
	}
	sort.Strings(ids)
	for i, id := range ids {
		if id == "" || (i > 0 && ids[i-1] == id) {
			return nil, &Error{422, "Choose distinct seats."}
		}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	seats, err := lockSeats(ctx, tx, eventID, ids)
	if err != nil {
		return nil, err
	}
	if len(seats) != len(ids) {
		return nil, &Error{404, "One or more seats do not exist."}
	}
	// Use the database clock after waiting for locks, so replicas cannot disagree
	// about an expired hold because their host clocks drift.
	var now int64
	if err := tx.QueryRow(ctx, "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint").Scan(&now); err != nil {
		return nil, err
	}
	hold := &Hold{
		ID: uuid.NewString(), EventID: eventID, ExpiresAt: now + int64(s.TTL.Seconds()),
		ServerTime: now, SeatIDs: ids,
	}
	for _, seat := range seats {
		if seat.OrderID != nil || (seat.HoldID != nil && seat.ExpiresAt != nil && *seat.ExpiresAt > now) {
			return nil, &Error{409, "Someone just grabbed one of those seats. Choose another spot."}
		}
		hold.SubtotalCents += seat.PriceCents
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO holds (id,user_id,event_id,expires_at,state,created_at)
		VALUES ($1,$2,$3,$4,'active',$5)`, hold.ID, userID, eventID, hold.ExpiresAt, now)
	if err != nil {
		return nil, err
	}
	for _, seat := range seats {
		if _, err = tx.Exec(ctx, `
			INSERT INTO hold_items (hold_id,event_id,seat_id,price_cents) VALUES ($1,$2,$3,$4)`,
			hold.ID, eventID, seat.ID, seat.PriceCents); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `
		UPDATE event_seats SET hold_id=$1,hold_expires_at=$2 WHERE event_id=$3 AND seat_id=ANY($4)`,
		hold.ID, hold.ExpiresAt, eventID, ids); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Redis is a TTL cache, never the authority for whether a seat may be sold.
	// A crash between the DB commit and SET cannot permit a duplicate booking.
	cacheCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := s.Redis.Set(cacheCtx, "hold:"+hold.ID, userID, time.Until(time.Unix(hold.ExpiresAt, 0))).Err(); err != nil {
		slog.Warn("hold cache write failed; durable hold remains valid", "error", err)
	}
	return hold, nil
}

func loadOrder(ctx context.Context, tx pgx.Tx, userID, key string) (*Order, error) {
	var order Order
	err := tx.QueryRow(ctx, `
		SELECT id,user_id,event_id,hold_id,idempotency_key,subtotal_cents,fee_cents,total_cents,created_at
		FROM orders WHERE user_id=$1 AND idempotency_key=$2`, userID, key).Scan(
		&order.ID, &order.UserID, &order.EventID, &order.HoldID, &order.IdempotencyKey,
		&order.SubtotalCents, &order.FeeCents, &order.TotalCents, &order.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "SELECT seat_id,section,price_cents FROM order_items WHERE order_id=$1 ORDER BY seat_id", order.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	order.Seats = []OrderSeat{}
	for rows.Next() {
		var seat OrderSeat
		if err := rows.Scan(&seat.ID, &seat.Section, &seat.PriceCents); err != nil {
			return nil, err
		}
		order.Seats = append(order.Seats, seat)
	}
	return &order, rows.Err()
}

func (s *Store) Checkout(ctx context.Context, holdID, userID, key string) (*Order, error) {
	if len(key) < 8 || len(key) > 100 || holdID == "" || userID == "" {
		return nil, &Error{422, "A hold and a valid idempotency key are required."}
	}
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize retries of the same logical checkout before checking the durable result.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", userID+":"+key); err != nil {
		return nil, err
	}
	existing, err := loadOrder(ctx, tx, userID, key)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.HoldID != holdID {
			return nil, &Error{409, "This checkout key was already used for a different hold."}
		}
		return existing, nil
	}
	var eventID, state string
	var expiresAt int64
	err = tx.QueryRow(ctx, `
		SELECT event_id,state,expires_at FROM holds WHERE id=$1 AND user_id=$2 FOR UPDATE`,
		holdID, userID).Scan(&eventID, &state, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &Error{404, "Hold not found."}
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "SELECT seat_id FROM hold_items WHERE hold_id=$1 ORDER BY seat_id", holdID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	seats, err := lockSeats(ctx, tx, eventID, ids)
	if err != nil {
		return nil, err
	}
	var now int64
	if err := tx.QueryRow(ctx, "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint").Scan(&now); err != nil {
		return nil, err
	}
	if state != "active" || expiresAt <= now || len(seats) == 0 || len(seats) != len(ids) {
		return nil, &Error{409, "Your hold has expired or was already checked out. Please choose seats again."}
	}
	order := &Order{
		ID: "SS-" + uuid.NewString(), UserID: userID, EventID: eventID, HoldID: holdID,
		IdempotencyKey: key, CreatedAt: now, Seats: []OrderSeat{},
	}
	for _, seat := range seats {
		if seat.OrderID != nil || seat.HoldID == nil || *seat.HoldID != holdID || seat.ExpiresAt == nil || *seat.ExpiresAt <= now {
			return nil, &Error{409, "These seats are no longer held for you."}
		}
		order.SubtotalCents += seat.PriceCents
		order.Seats = append(order.Seats, seat.OrderSeat)
	}
	order.FeeCents = (order.SubtotalCents*8 + 50) / 100
	order.TotalCents = order.SubtotalCents + order.FeeCents
	if _, err = tx.Exec(ctx, `
		INSERT INTO orders (id,user_id,event_id,hold_id,idempotency_key,subtotal_cents,fee_cents,total_cents,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		order.ID, userID, eventID, holdID, key, order.SubtotalCents, order.FeeCents, order.TotalCents, now); err != nil {
		return nil, err
	}
	for _, seat := range seats {
		if _, err = tx.Exec(ctx, `
			INSERT INTO order_items (order_id,event_id,seat_id,section,price_cents) VALUES ($1,$2,$3,$4,$5)`,
			order.ID, eventID, seat.ID, seat.Section, seat.PriceCents); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `
		UPDATE event_seats SET order_id=$1,hold_id=NULL,hold_expires_at=NULL
		WHERE event_id=$2 AND seat_id=ANY($3)`, order.ID, eventID, ids); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE holds SET state='consumed' WHERE id=$1", holdID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.deleteCache(holdID)
	return order, nil
}

func (s *Store) Release(ctx context.Context, holdID, userID string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var state string
	err = tx.QueryRow(ctx, "SELECT state FROM holds WHERE id=$1 AND user_id=$2 FOR UPDATE", holdID, userID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return &Error{404, "Hold not found."}
	}
	if err != nil {
		return err
	}
	if state == "active" {
		// Lock in the same order as checkout and acquisition before the UPDATE.
		rows, err := tx.Query(ctx, "SELECT seat_id FROM event_seats WHERE hold_id=$1 ORDER BY seat_id FOR UPDATE", holdID)
		if err != nil {
			return err
		}
		for rows.Next() {
			// Consume the result to acquire every row lock.
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `
			UPDATE event_seats SET hold_id=NULL,hold_expires_at=NULL WHERE hold_id=$1 AND order_id IS NULL`, holdID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE holds SET state='released' WHERE id=$1", holdID); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.deleteCache(holdID)
	return nil
}

func (s *Store) deleteCache(holdID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := s.Redis.Del(ctx, "hold:"+holdID).Err(); err != nil {
		slog.Warn("hold cache deletion failed; TTL will clean up", "error", err)
	}
}

func (s *Store) Health(ctx context.Context) error {
	if err := s.DB.Ping(ctx); err != nil {
		return fmt.Errorf("database: %w", err)
	}
	return nil
}
