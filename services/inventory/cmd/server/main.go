package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"seatsage/inventory/internal/booking"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func fail(w http.ResponseWriter, err error) {
	var bookingErr *booking.Error
	if errors.As(err, &bookingErr) {
		jsonResponse(w, bookingErr.Status, map[string]string{"detail": bookingErr.Message})
		return
	}
	slog.Error("inventory operation failed", "error", err)
	jsonResponse(w, 503, map[string]string{"detail": "Inventory is temporarily unavailable. Retry with the same checkout key."})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		jsonResponse(w, 400, map[string]string{"detail": "Invalid JSON request."})
		return false
	}
	return true
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	poolConfig, err := pgxpool.ParseConfig(env("DATABASE_URL", "postgres://seatsage:seatsage@localhost:5432/seatsage"))
	if err != nil {
		slog.Error("invalid database configuration", "error", err)
		os.Exit(1)
	}
	poolConfig.MaxConns = 30
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		slog.Error("database initialization failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	redisOptions, err := redis.ParseURL(env("REDIS_URL", "redis://localhost:6379/0"))
	if err != nil {
		slog.Error("invalid Redis configuration", "error", err)
		os.Exit(1)
	}
	redisOptions.MaxRetries = -1
	redisOptions.DialTimeout = 300 * time.Millisecond
	cache := redis.NewClient(redisOptions)
	defer cache.Close()
	ttl, err := strconv.Atoi(env("HOLD_TTL_SECONDS", "300"))
	if err != nil || ttl < 10 || ttl > 900 {
		slog.Error("HOLD_TTL_SECONDS must be between 10 and 900")
		os.Exit(1)
	}
	store := &booking.Store{DB: pool, Redis: cache, TTL: time.Duration(ttl) * time.Second}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Health(r.Context()); err != nil {
			fail(w, err)
			return
		}
		jsonResponse(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /inventory/events/{eventID}/seats", func(w http.ResponseWriter, r *http.Request) {
		seats, err := store.Seats(r.Context(), r.PathValue("eventID"), r.URL.Query().Get("user_id"))
		if err != nil {
			fail(w, err)
			return
		}
		jsonResponse(w, 200, map[string]any{"seats": seats, "server_time": time.Now().Unix()})
	})
	mux.HandleFunc("POST /inventory/holds", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			EventID string   `json:"event_id"`
			SeatIDs []string `json:"seat_ids"`
			UserID  string   `json:"user_id"`
		}
		if !decode(w, r, &body) {
			return
		}
		hold, err := store.CreateHold(r.Context(), body.EventID, body.SeatIDs, body.UserID)
		if err != nil {
			fail(w, err)
			return
		}
		jsonResponse(w, 201, hold)
	})
	mux.HandleFunc("DELETE /inventory/holds/{holdID}", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Release(r.Context(), r.PathValue("holdID"), r.URL.Query().Get("user_id")); err != nil {
			fail(w, err)
			return
		}
		jsonResponse(w, 200, map[string]bool{"released": true})
	})
	mux.HandleFunc("POST /inventory/checkout", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			HoldID         string `json:"hold_id"`
			UserID         string `json:"user_id"`
			IdempotencyKey string `json:"idempotency_key"`
		}
		if !decode(w, r, &body) {
			return
		}
		order, err := store.Checkout(r.Context(), body.HoldID, body.UserID, body.IdempotencyKey)
		if err != nil {
			fail(w, err)
			return
		}
		jsonResponse(w, 200, order)
	})
	token := env("INVENTORY_TOKEN", "local-inventory-change-me")
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Inventory-Token")), []byte(token)) != 1 {
			jsonResponse(w, 401, map[string]string{"detail": "Unauthorized service request."})
			return
		}
		requestCtx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(requestCtx))
	})
	server := &http.Server{
		Addr: ":8081", Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()
	slog.Info("inventory service listening", "address", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
