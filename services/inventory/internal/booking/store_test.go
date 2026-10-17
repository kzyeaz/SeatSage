package booking

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func fixture(t *testing.T) (*Store, string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "infra", "postgres", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379/15"
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	options.MaxRetries = -1
	client := redis.NewClient(options)
	eventID := "test-" + uuid.NewString()
	_, err = pool.Exec(ctx, `
		INSERT INTO events (id,title,category,city,venue,starts_at,image,accent,description,tags,organizer_id,created_at)
		VALUES ($1,'Race test','Music','New York','Test venue','2030-01-01','','','Test','[]','test',0)`, eventID)
	if err != nil {
		t.Fatal(err)
	}
	for _, seatID := range []string{"A1", "A2", "A3", "A4"} {
		if _, err = pool.Exec(ctx, `
			INSERT INTO event_seats(event_id,seat_id,section,row_label,seat_number,price_cents)
			VALUES ($1,$2,'Standard','A',1,10000)`, eventID, seatID); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		// Only this test's event data is removed.
		for _, query := range []string{
			"DELETE FROM order_items WHERE event_id=$1",
			"DELETE FROM hold_items WHERE event_id=$1",
			"DELETE FROM event_seats WHERE event_id=$1",
			"DELETE FROM orders WHERE event_id=$1",
			"DELETE FROM holds WHERE event_id=$1",
			"DELETE FROM events WHERE id=$1",
		} {
			if _, err := pool.Exec(ctx, query, eventID); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
		client.Close()
		pool.Close()
	})
	return &Store{DB: pool, Redis: client, TTL: 300 * time.Second}, eventID
}

func TestConcurrentHoldAndIdempotentCheckout(t *testing.T) {
	store, eventID := fixture(t)
	ctx := context.Background()
	start := make(chan struct{})
	winners := make(chan *Hold, 64)
	var rejected atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 64; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			hold, err := store.CreateHold(ctx, eventID, []string{"A2", "A1"}, "buyer")
			if err == nil {
				winners <- hold
				return
			}
			var bookingError *Error
			if errors.As(err, &bookingError) && bookingError.Status == 409 {
				rejected.Add(1)
			} else {
				t.Errorf("unexpected hold error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(winners)
	if len(winners) != 1 || rejected.Load() != 63 {
		t.Fatalf("winners=%d conflicts=%d; expected 1 and 63", len(winners), rejected.Load())
	}
	hold := <-winners
	orders := make(chan string, 32)
	for n := 0; n < 32; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			order, err := store.Checkout(ctx, hold.ID, "buyer", "same-idempotency-key")
			if err != nil {
				t.Errorf("checkout: %v", err)
				return
			}
			if order.TotalCents != 21600 || len(order.Seats) != 2 {
				t.Errorf("invalid order: %+v", order)
			}
			orders <- order.ID
		}()
	}
	wg.Wait()
	close(orders)
	unique := map[string]bool{}
	for id := range orders {
		unique[id] = true
	}
	if len(unique) != 1 {
		t.Fatalf("expected one order, got %d", len(unique))
	}
	var count int
	if err := store.DB.QueryRow(ctx, "SELECT COUNT(*) FROM order_items WHERE event_id=$1", eventID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("expected exactly 2 sold seat records, got %d, err=%v", count, err)
	}
}

func TestExpiryOwnershipAndAtomicGroups(t *testing.T) {
	store, eventID := fixture(t)
	ctx := context.Background()
	old, err := store.CreateHold(ctx, eventID, []string{"A2"}, "old")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.CreateHold(ctx, eventID, []string{"A1", "A2"}, "other"); err == nil {
		t.Fatal("overlapping group must fail")
	}
	seats, err := store.Seats(ctx, eventID, "other")
	if err != nil || seats[0].Status != "available" {
		t.Fatal("failed group must leave A1 available")
	}
	if err = store.Release(ctx, old.ID, "stranger"); err == nil {
		t.Fatal("another user cannot release a hold")
	}
	expired := time.Now().Unix() - 1
	if _, err = store.DB.Exec(ctx, "UPDATE holds SET expires_at=$1 WHERE id=$2", expired, old.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.DB.Exec(ctx, "UPDATE event_seats SET hold_expires_at=$1 WHERE hold_id=$2", expired, old.ID); err != nil {
		t.Fatal(err)
	}
	newHold, err := store.CreateHold(ctx, eventID, []string{"A2"}, "new")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Checkout(ctx, old.ID, "old", "expired-checkout"); err == nil {
		t.Fatal("expired hold must not checkout")
	}
	if err = store.Release(ctx, old.ID, "old"); err != nil {
		t.Fatal(err)
	}
	// Losing the TTL key must not invalidate the durable reservation.
	store.Redis.Del(ctx, "hold:"+newHold.ID)
	if _, err = store.Checkout(ctx, newHold.ID, "new", "new-checkout-key"); err != nil {
		t.Fatalf("stale release or cache loss affected the new hold: %v", err)
	}
}
