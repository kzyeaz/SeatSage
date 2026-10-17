# Reproducible load tests

Run only against your isolated demo stack. The workloads create durable orders; reusing sold stock changes the meaning of a later test.

## Correctness under contention

`TicketBuyer` deliberately overlaps requests on the 72 `afterglow` seats. Most successful holders release; some check out and retry with the same idempotency key. Expected seat conflicts are reported as a separate request metric, not unexpected failures.

```sh
docker compose --profile load run --rm locust \
  -f locustfile.py TicketBuyer --host http://web \
  --headless --users 100 --spawn-rate 20 --run-time 45s \
  --csv /mnt/locust/results/contention --html /mnt/locust/results/contention.html
```

Create `load/results/` first. The directory is ignored by Git. For an interactive Locust UI:

```sh
docker compose --profile load up locust
```

Open http://localhost:8089. Explicitly select the appropriate user class for your scenario.

On **Windows Git Bash**, prefix the `docker compose ... run` commands with `MSYS_NO_PATHCONV=1` so paths such as `/mnt/locust/results/...` reach the container unchanged. PowerShell does not perform this path conversion; use PowerShell backticks instead of Bash backslashes for multiline commands.

## 1,000-user checkout scenario

The small storefront inventory would sell out too quickly to measure checkout throughput. `CheckoutBuyer` uses a dedicated synthetic event with 100,000 seats instead.

Prepare fresh inventory using Bash, Git Bash, or a shell supporting input redirection:

```sh
docker compose exec -T api python - < load/prepare.py
```

PowerShell equivalent:

```powershell
Get-Content -Raw load/prepare.py | docker compose exec -T api python -
```

Then run:

```sh
docker compose --profile load run --rm locust \
  -f locustfile.py CheckoutBuyer --host http://web \
  --headless --users 1000 --spawn-rate 100 --run-time 2m \
  --csv /mnt/locust/results/checkout-1000 \
  --html /mnt/locust/results/checkout-1000.html
```

Use `--users 1100` if specifically testing more than 1,000 active simulated buyers. The defaults are a 0.1–0.5 second think time, one seat per checkout, and a 10% chance of retrying a completed checkout with the same key.

For another fresh run, set a new event ID on **both** commands:

```sh
docker compose exec -T -e LOAD_EVENT_ID=load-run-2 api python - < load/prepare.py
docker compose --profile load run --rm -e LOAD_EVENT_ID=load-run-2 locust \
  -f locustfile.py CheckoutBuyer --host http://web \
  --headless --users 1000 --spawn-rate 100 --run-time 2m \
  --csv /mnt/locust/results/checkout-run-2
```

This synthetic fixture is intended for API testing; its large seat map is not a real venue layout for the browser. Preparing a fixture never deletes or resets an existing event.

## Audit the resulting database

```sh
docker compose exec -T postgres psql -U seatsage -d seatsage < load/audit.sql
```

All four queries must return zero rows:

1. Duplicate sales of the same event-seat pair.
2. Disagreement between sold-seat references and order items.
3. Consumed holds without exactly one order.
4. Totals inconsistent with ticket prices and the 8% fee.

Also count successful orders and tickets, scoped to the load fixture. A test with zero completed checkouts is not useful evidence of checkout correctness.

```sql
SELECT event_id, COUNT(*) AS completed_orders
FROM orders WHERE event_id LIKE 'load-%' GROUP BY event_id;
```

## What to report

Record the commit/version, machine or AWS instance sizes, service replica counts, database configuration, Locust worker count, ramp-up, steady-state time, number of users, successful checkout count, expected conflicts, unexpected failures, requests/sec, p50/p95/p99 checkout latency, and audit results.

The included Compose configuration is a development topology: one API worker, one Go process with a 30-connection pool, and one host for clients and services. A high user count can expose saturation and queueing. It does not automatically validate a latency or throughput target.

Keep throughput and correctness distinct. Zero duplicate sales with many `503` errors demonstrates a maintained invariant under overload, not a healthy production service. Do not describe virtual users as simultaneous completed purchases.
