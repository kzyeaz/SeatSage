# Validation record

This file records executed checks separately from intended deployment and load-test scenarios.

The application includes local SQLite and distributed PostgreSQL/Go modes. Passing local tests does not establish distributed correctness or throughput.

## Executed checks — October 16, 2026

| Check | Result |
| --- | --- |
| Python transaction and API suite | **10 passed** |
| React / TypeScript production build | **Passed**, including Linux container build |
| Playwright, SQLite mode | **Desktop and mobile passed** |
| Playwright, full Docker stack | **Desktop passed** |
| Go `vet` and PostgreSQL integration tests with `-race` | **Passed**, no race detector findings |
| Docker Compose build and startup | **All six services running**, all configured health checks passing |
| Elasticsearch | Active in distributed mode; organizer-created event found through indexed search |
| Terraform initialization and validation | **Passed**; no AWS plan or deployment executed |

Go integration coverage includes 64 competing hold requests for the same two seats (one winner, 63 conflicts), 32 concurrent retries of one checkout (one order), expired holds, ownership checks, atomic group acquisition, and deleting the Redis key before checkout.

The browser checks exercise publishing, discovery, saved events, selecting two seats, reserving, simulated checkout, ticket download, order persistence, and organizer sales totals. Browser screenshots were inspected at desktop and mobile sizes.

Distributed browser verification caught overly broad Elasticsearch matching for multiword searches. The query now requires all search terms while retaining fuzzy matching. A successful browser rerun verified the correction.

The local Python suite emitted one deprecation warning from Starlette's TestClient use of an AnyIO alias; there were no test failures.

## Measured Locust run

The final run used the distributed Docker stack on Windows Docker Desktop/WSL2, on an AMD Ryzen 7 5800HS host. Docker reported **16 logical CPUs and 8,011,022,336 bytes of available VM memory**. Clients and all services shared this machine. There was one Locust process, one Uvicorn worker, one Go process with a 30-connection pool, PostgreSQL 16, Redis 7, and Elasticsearch 8.17.3.

- Workload: `CheckoutBuyer`, 1,100 users, spawning 100 users/second.
- Inventory: a fresh `load-optimized` event with 100,000 synthetic seats; one ticket per purchase.
- Timing: 120-second run, followed by approximately 7 seconds of in-flight task draining; 45-second maximum stop timeout.
- Think time: 0.1–0.5 seconds. Ten percent of completed purchases are randomly selected for an idempotent retry.
- Run timestamps: **2026-10-17 00:55:40–00:57:46 UTC** (October 16 in the host timezone).

| Metric | Final result |
| --- | ---: |
| Peak simulated users | **1,100** |
| Successful new checkouts | **8,374** |
| Successful idempotent checkout retries | **820** |
| Expected competing-seat conflicts | **377** |
| Total recorded requests | **19,045** |
| Unexpected request failures | **0** |
| New checkouts/sec, including ramp and drain | **66.51** |
| All requests/sec, including ramp and drain | **151.27** |
| Checkout mean latency | **6.668 seconds** |
| Checkout p50 / p95 / p99 | **5.9 / 13 / 14 seconds** |
| Maximum observed checkout latency | **15.349 seconds** |

The database audit returned **zero rows for all four violation queries** in `load/audit.sql`: no duplicate event-seat sales, no seat/order-item disagreement, no consumed hold without an order, and no inconsistent order totals. Database counts independently confirmed **8,374 orders and 8,374 sold seats** for this run. Verification fixtures were removed afterward to leave a clean storefront.

The first run completed 4,512 checkouts with zero unexpected failures and a 17-second checkout p95. Its audit also passed. Profiling identified an approximately 42 ms full scan of 100,000 seats during every receipt enrichment. The final implementation returns cached immutable event metadata in receipts, avoiding that scan. These are two observed demo runs, not a controlled capacity study.

**Latency remains high at this load.** The result supports a booking-correctness claim under 1,100 simulated buyers, not a low-latency production-readiness claim.

### Evidence

- [Final report data](benchmarks/checkout-1100-report.json), extracted without modification from Locust's generated HTML report.
- [Periodic statistics CSV](benchmarks/checkout-1100-stats.csv).
- [User-count and latency history](benchmarks/checkout-1100-history.csv).
- The full interactive HTML report is available locally at `load/results/checkout-1100-optimized.html` and is ignored by Git.

Locust writes the CSV periodically, so its last snapshot precedes the final task drain. The final report data and database counts are authoritative for the totals above.

## Performance claims

“1,000 Locust users” means 1,000 simulated clients. It does not mean that 1,000 database transactions held locks simultaneously, nor that 1,000 purchases completed per second.

A defensible performance statement must include the actual environment, ramp-up, duration, checkout count, throughput, latency, unexpected failures, and a post-run database audit.

Resume wording supported by this demo:

> Built a demo ticketing marketplace with React, versioned FastAPI APIs, and a Go inventory service; implemented Redis TTL hold markers, PostgreSQL row-level locking, and idempotent checkout, validating 8,374 purchases with no duplicate seat sales in a 1,100-user Locust run.

AWS deployment is represented by validated Terraform, not an executed cloud deployment. Do not claim this benchmark ran on AWS.
