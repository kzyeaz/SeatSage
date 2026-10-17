# SeatSage

**Be there. Feel everything.** A working event-ticketing demo with a React storefront, versioned FastAPI API, Go inventory service, PostgreSQL, Redis, and Elasticsearch.

Browse six sample experiences, save favorites, pick seats on an interactive map, reserve them for five minutes, and complete a simulated checkout. Switch to the organizer workspace to publish an event and watch its ticket sales update.

**No real payments or admission tickets.** Organizer access is an intentionally open demo persona. The AWS configuration is supplied separately; running the local app does not deploy anything.

## Run the demo

### Quick start — no Docker needed

Requires Python 3.11+ and Node.js 22+.

```sh
python scripts/dev.py --setup
```

Open **http://localhost:5173**. Interactive API docs: **http://localhost:8000/docs**.

On subsequent runs:

```sh
python scripts/dev.py
```

This mode uses FastAPI and a persistent SQLite database at `data/seatsage.db`. SQLite serializes writes with `BEGIN IMMEDIATE`; it does **not** exercise Go, Redis, Elasticsearch, or PostgreSQL row locks. The footer labels it “Local demo.”

To customize settings, copy `.env.example` to `.env`. Stop the launcher with Ctrl+C. To start fresh, stop the app and remove only the generated `data/seatsage.db` and its `-wal`/`-shm` companion files.

### Full service stack

Requires a running Docker Desktop engine with approximately 5 GB of memory available. No local Python, Go, or Node installation is necessary.

```sh
docker compose up --build -d
docker compose ps
```

Open **http://localhost:8080**. The first build downloads service images and can take several minutes. Only the web port is published; databases and the Go service are internal.

If you access the app through a browser-preview proxy on another origin, add that exact origin to `ALLOWED_ORIGINS` before recreating the API container. This setting is a comma-separated list; direct localhost access works with the defaults.

```sh
docker compose logs -f api inventory
docker compose down
```

Named volumes retain the demo data. `docker compose down -v` **deletes the demo databases**; use it only when you intend to reset the stack.

## Take a two-minute tour

1. Search by event, artist description, or venue. Filter by category or city and sort by date or price.
2. Save a card with the heart icon; find it under **Saved**.
3. Open an event, select up to six seats, and choose **Reserve my seats**.
4. Watch the hold timer, accept the demo acknowledgment, and confirm. Download a sample ticket or open **My tickets**.
5. Open the same event in a private browser window: purchased seats are unavailable.
6. Choose **For organizers**. Real demo sales appear in the dashboard. **Create an event** publishes a new 72-seat experience that can immediately be booked.

All prices use integer cents. The total includes an explicitly disclosed 8% service fee. Dates are displayed in the venue’s timezone.

## Design

```mermaid
flowchart LR
    Browser["React + TypeScript"] --> Web["Vite locally / Nginx in Docker"]
    Web --> API["FastAPI /api/v1"]
    API --> Search["Elasticsearch\nrebuildable discovery index"]
    API --> PG[("PostgreSQL\ncatalog + durable bookings")]
    API --> Inventory["Go inventory service\ninternal authenticated HTTP"]
    Inventory --> PG
    Inventory --> Redis[("Redis\nhold:{id}, TTL")]
    API -. "local mode adapter" .-> SQLite[("SQLite")]
```

FastAPI owns the browser session, catalog, search, order views, and organizer workflow. The Go service owns all distributed inventory writes. PostgreSQL row locks serialize overlapping seat selections; immutable order items have a unique `(event_id, seat_id)` constraint. Redis stores expiring hold markers, while the database stores the authoritative deadline. Checkout retries use a durable idempotency key.

Read [the architecture and failure-mode walkthrough](docs/architecture.md) for the data model, transaction sequence, API contract, and scaling decisions. Read [the AWS deployment guide](infra/aws/README.md) for the Terraform demo and the proposed production topology.

## Verification

Local transaction and API checks:

```sh
# Windows
.venv/Scripts/python -m pytest api/tests -q
# macOS / Linux
.venv/bin/python -m pytest api/tests -q
```

Frontend:

```sh
npm --prefix web ci
npm --prefix web run build
# With the local demo running, from web/:
npx playwright install chromium
npm run test:e2e
```

The browser suite covers event publishing, discovery, saving, seat selection, checkout, ticket download, session persistence, and organizer sales on desktop and mobile. It creates distinctly named test events in the target demo database. Set `BASE_URL=http://localhost:8080` to target Docker instead.

Go integration tests require disposable PostgreSQL and Redis instances:

```sh
# From services/inventory; set these environment variables in your shell first.
# TEST_DATABASE_URL=postgres://user:password@localhost:5432/seatsage_test
# TEST_REDIS_URL=redis://localhost:6379/15
go test -race ./...
```

They race 64 hold requests for the same seats, retry checkout concurrently, and exercise expiration, ownership, atomic seat groups, and loss of a Redis hold key. Without `TEST_DATABASE_URL`, integration tests are explicitly skipped. CI provisions these dependencies.

See [load testing](load/README.md) for Locust, database invariant audits, and what is required to substantiate “1,000+ concurrent checkouts.” A workload configuration is not a benchmark result; consult [validation notes](docs/validation.md) before making a performance claim.

The executed Docker run used **1,100 simulated buyers** and completed **8,374 purchases**, with zero unexpected request failures and no duplicate seat sales. Checkout p95 was **13 seconds** on the shared development machine. The validation notes include the environment, raw report data, and limitations.

## Repository map

| Path | Purpose |
| --- | --- |
| `web/` | React storefront, organizer dashboard, browser tests |
| `api/app/` | FastAPI routes, sessions, catalog, SQL adapter, local inventory |
| `services/inventory/` | Go transactional inventory service and integration tests |
| `infra/postgres/schema.sql` | Shared relational schema and invariants |
| `compose.yaml` | Full local service stack |
| `infra/aws/` | Terraform demo deployment and AWS design |
| `load/` | Locust workloads and post-run correctness audit |
| `docs/` | Architecture, tradeoffs, validation record |
| `scripts/dev.py` | Cross-platform local launcher |

## Demo boundaries

- Checkout is simulated. There is no payment gateway, refund, transfer, resale, admission scanner, or email delivery.
- Fans and organizers have distinct UI workflows. The organizer persona and its events are shared by all demo visitors; this is not production tenant isolation.
- Signed, HttpOnly browser sessions enforce hold/order ownership. There is no account registration or external identity provider.
- The 72-seat maps are illustrative layouts, not the real seating plans of the named venues.
- Sample event images load from Unsplash; typography loads from Google Fonts. Internet access is required for those assets.
- Search degrades to SQL when Elasticsearch is unavailable. The demo index is rebuilt on API startup and after publishing an event.
- AWS infrastructure incurs charges if applied. It has not been deployed merely by creating this repository.
