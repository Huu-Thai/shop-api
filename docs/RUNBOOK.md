# shop — runbook

## Deploy

1. **Build** one image per target: `docker build --target api|worker|migrate .`
2. **Migrate** with the `migrate` image as a one-off release job (`prisma migrate deploy`). The app never migrates on boot.
3. **Roll out** the `api` replicas (stateless) and the `worker` deployments. Use `WORKER_QUEUES` to split queue groups across deployments.
4. **Sizing:** each process holds up to `DATABASE_POOL_MAX` (20) connections and fails a query that waits more than `DATABASE_POOL_TIMEOUT_MS` (10 s) for one: keep (API replicas + worker processes) × pool below Postgres `max_connections`. One API container served the SLO load (≈ 75 req/s with 2 checkouts/s) within its SLOs; checkouts are the expensive requests (each cart step is priced in full), so add API replicas for checkout-heavy traffic. When `S3_ENDPOINT` is internal, set `S3_PUBLIC_ENDPOINT` so export download links work in browsers.
5. **First install only:** run `node dist/cli/create-admin.js` with `ADMIN_EMAIL` and `ADMIN_PASSWORD` set, in an api container. For a demo or staging catalog, also run `node dist/cli/seed-demo.js`.

| Probe     | Path                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------ |
| Liveness  | `GET /api/v1/health/live`                                                                              |
| Readiness | `GET /api/v1/health`. Returns 503 when Postgres, Redis (authenticated PING) or object storage is down. |
| Worker    | `GET :9464/health` (liveness of the worker process, next to its `/metrics`)                            |

Required secrets: `DATABASE_URL`, `REDIS_PASSWORD` (≥16 chars in production), `AUTH_JWT_SECRET` (≥32), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and, in production, `METRICS_TOKEN` (≥16) and an https `API_PUBLIC_URL`. The process refuses to start and lists every missing or invalid variable at once.

## Monitoring

- **Metrics:** the API serves Prometheus metrics at `GET /api/v1/metrics`, each worker at `:9464/metrics` (`WORKER_METRICS_PORT`). Both need `Authorization: Bearer $METRICS_TOKEN` (required in production). Keep them off the public internet anyway: expose them to the Prometheus network only.
- **What is measured:**
  - HTTP latency by route template, method and status (`shop_http_request_duration_seconds`);
  - background job durations by queue, name and outcome (`shop_queue_job_duration_seconds`);
  - orders, payments, payment notifications and failed sign-ins (`shop_orders_placed_total`, `shop_payments_total`, `shop_payment_webhooks_total`, `shop_auth_failures_total`);
  - job executions and webhook deliveries (`shop_job_executions_total`, `shop_webhook_deliveries_total`);
  - backlogs read at scrape time: queues, the outbox, queued and running executions, pending webhook deliveries, payments pending over 15 minutes, pending refunds;
  - process metrics: CPU, memory, event-loop lag, GC.
    Counters are per process (use `sum()`); the backlog gauges describe shared state, so every API replica reports the same values (use `max()`).
- **Locally:** `docker compose --profile app --profile monitoring up -d` adds Prometheus (`:9091`), Alertmanager (`:9094`, alerts e-mailed to Mailpit at `:8026`) and Grafana (`:3301`, dashboard "Shop overview"; user `admin`, password `GRAFANA_ADMIN_PASSWORD`).
- **Elsewhere:** keep `ops/prometheus/alerts.yml` (rules) and `ops/grafana/dashboards/shop-overview.json` (dashboard); point the scrape targets at your API and worker services; route `critical` alerts to a pager and `warning` to chat or e-mail (`ops/alertmanager/alertmanager.yml` is the local example).
- **Changing alerts:** edit `ops/prometheus/alerts.yml` and its tests in `alerts.test.yml`, then run `npm run ops:check` (promtool lint + unit tests, needs Docker).

## SLOs

| Objective                                                   | Target           | Measured by                           |
| ----------------------------------------------------------- | ---------------- | ------------------------------------- |
| Availability: requests answered without a 5xx               | ≥ 99% (5 min)    | `shop:http_errors:ratio5m`            |
| Storefront reads (catalog, product pages, config, URLs) p95 | ≤ 300 ms         | `shop:storefront_read_latency_p95:5m` |
| Storefront reads p99                                        | ≤ 1 s            | load test                             |
| Search and suggestions p95                                  | ≤ 400 ms         | load test                             |
| Cart and checkout writes p95                                | ≤ 1 s            | `shop:checkout_latency_p95:5m`        |
| Placing an order p95                                        | ≤ 1.5 s          | load test                             |
| After-events delivered (stock, search, points, webhooks)    | within 5 minutes | `shop_outbox_oldest_seconds`          |

`loadtest/storefront.js` (k6) checks these against a seeded stack: catalog browsing and search at a constant rate plus guest checkouts with cash on delivery. The thresholds are the SLOs, so k6 fails when one is missed:

```sh
docker run --rm -i --network <stack network> -e BASE_URL=http://api:3000 grafana/k6 run - < loadtest/storefront.js
# BROWSE_RPS (60), CHECKOUTS_PER_S (2), DURATION (3m), STORE (us-en) and RETURN_URL can be set.
```

Raise `THROTTLE_LIMIT` for the stack under test: the per-IP rate limit would otherwise answer 429 to a load generator on one machine. Give the checkout SKUs enough stock first (an `import.stock` job does it).

## Incidents

### Locked out of the admin

Run `admin:create` with the same e-mail. It resets the password, clears the lockout, re-activates the account, re-attaches `super-admin`, and records the change in the audit log as the `system` actor.

### Suspected stolen admin session or token

- **One user:** `PATCH /admin/users/:id { "status": "DISABLED" }`. This revokes all of that user's sessions immediately, access tokens included.
- **Your own sessions:** `POST /admin/auth/logout?everywhere=true`.
- **Everyone:** rotate `AUTH_JWT_SECRET` and restart the api. All access tokens become invalid at once, but refresh tokens still work, so also revoke them: `UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL`.
- A reused refresh token automatically revokes its whole session and logs `auth.token-reuse-detected`. Search the audit log for that action.

### Leaked API key

`DELETE /admin/api-keys/:id` takes effect immediately. Then create a replacement with the same permissions.

### Redis authentication errors (`NOAUTH` / `WRONGPASS`)

The app's `REDIS_PASSWORD` no longer matches the server's `requirepass`. Fix the secret and restart the api and workers. Nothing in Redis needs recovering: queues retry, caches rebuild, and the session-revocation keys expire with the access tokens anyway.

### Outbox backlog

Delivered events are deleted from `outbox_events`. Whatever is left is either pending or parked:

- **Pending:** waiting for a retry with backoff (`failed_at IS NULL`).
- **Parked:** a dead letter after `OUTBOX_MAX_ATTEMPTS` failures (`failed_at` is set).

```sql
SELECT event_name, attempts, failed_at, last_error FROM outbox_events ORDER BY created_at LIMIT 50;
-- after fixing the cause, re-queue the parked ones:
UPDATE outbox_events SET failed_at = NULL, attempts = 0, available_at = now() WHERE failed_at IS NOT NULL;
```

### Storefront URLs wrong or missing

URL rewrites are rebuilt automatically after product, category and store changes. To rebuild them manually, call `POST /api/v1/admin/url-rewrites/rebuild` with `{ "storeId": "…" }`, or with `{}` for every store. The rebuild runs on the `catalog` queue, so a worker must be running it.

When a URL is missing, look for this warning in the logs: `URL … is taken in store …`. It means two pages want the same path. Rename one of the slugs; the vetoes prevent new collisions.

### Images without renditions

Renditions are produced on the `media` queue. If storefront images have an empty `renditions` list, check that a worker runs the `media` queue (`WORKER_QUEUES` empty, or including `media`), and look at its failed jobs. Uploading the same file again does not queue a new job, because identical content is deduplicated.

Without `MEDIA_PUBLIC_BASE_URL`, image URLs are signed and expire after `S3_SIGNED_URL_TTL`. In production, put a CDN in front of the bucket and set that variable.

### Wrong or missing storefront prices

Use `GET /api/v1/admin/prices/preview?variantId=…&storeId=…&customerGroup=guest` to compare the live resolution with what the storefront shows.

- **If the preview is right but the storefront isn't:** the index is behind. Check that a worker runs the `price-index` queue, then call `POST /api/v1/admin/prices/reindex` with `{}` (everything) or `{ "variantIds": [...] }`.
- **If the preview is wrong:** check the matching books (currency, scope, group, validity, `isActive`) and the tax rates for the store's country.
- **A missing price in a display currency:** prices in a non-default currency without their own book are converted with the latest exchange rate. Add one with `POST /admin/exchange-rates`.

### Stock looks wrong / "only N available"

- **Investigate:**
  - `GET /admin/inventory/stock?sku=…` shows quantity, reserved, safety stock and salable per source.
  - `GET /admin/inventory/movements?variantId=…` shows the ledger.
- **Stuck reservations** are released by the `inventory-expire-reservations` job every minute.
- **A drifted reserved counter** is fixed nightly by `inventory-reconcile`. To run it now, release the stuck reservation group, or wait for the job.
- **Counting stock:** a physical count is `POST /admin/inventory/adjustments` with `quantity` (recorded as CORRECTION in the ledger). Pass `expectedVersion` to avoid overwriting a concurrent change.

### Search results wrong, missing or stale

1. **Check the engine:** `GET /api/v1/admin/search/websites/:id` shows the active engine, any switch in progress (`status`, `lastError`) and the document count per store and locale.
2. **Check who answered:** the storefront's `X-Search-Engine` header says which engine served a request. `POSTGRES-FALLBACK` means the external engine is failing (see the api logs).
3. **Reindex** a website with `POST /api/v1/admin/search/websites/:id/reindex`. This needs a worker on the `search-index` queue.
4. **A failed switch** leaves the old engine serving. Fix the cause (connectivity, credentials) and `PUT` the same settings again to retry.
5. **Rotating `APP_ENCRYPTION_KEY`** makes stored engine credentials unreadable, and search falls back to Postgres. Re-enter the connection with `PUT`.

### Content not appearing or not disappearing on time

1. **Check the window:** `GET /api/v1/admin/cms/pages/:id` (or posts, blocks, banners, sliders) shows `status`, `publishedAt`, `unpublishedAt` and `visible`. The storefront shows content whose window contains _now_, whatever the scheduler has done. Remember the storefront's CDN cache (`max-age=60`).
2. **Check the schedule:** `GET /api/v1/admin/schedules?targetId=…`. A `PENDING` row past its `runAt` means no worker runs the `scheduler` queue; `DONE` means it ran (the owner ignores a schedule the content no longer calls for).
3. **A page or post URL that doesn't resolve:** the resolver hides content that isn't visible yet. If it is visible, check `GET /api/v1/admin/url-rewrites?targetId=…`; republishing (or editing) the content rebuilds its URLs. A slug that collides with another page's URL in the same store is logged by the api as a URL collision.
4. **Block not rendered:** the block must be published and have a translation in the request's locale chain; a store block with the same identifier overrides the global one in that store.

### A customer can't sign in

1. Accounts lock for `AUTH_LOCKOUT_MINUTES` after `AUTH_MAX_FAILED_LOGINS` wrong passwords (the response stays a generic 401). `GET /api/v1/admin/customers?search=…` shows `lockedUntil` and `status`.
2. `PATCH /api/v1/admin/customers/:id {"status": "ACTIVE"}` re-enables an account and lifts a lockout.
3. Accounts are per website: an account made on one website doesn't sign in on another website's stores.
4. A suspected stolen session: `POST /api/v1/admin/customers/:id/logout` ends all of them.

### A coupon or promotion doesn't apply

1. Preview the cart: `POST /api/v1/admin/marketing/promotions/evaluate` with the website, currency, items and coupon. `coupon.status` says why (`NOT_FOUND`, `INACTIVE`, `EXPIRED`, `USED_UP`, `NOT_APPLICABLE`).
2. `INACTIVE`: the promotion or its campaign isn't running now (`GET …/promotions/:id` shows `active`), the coupon is switched off, or the promotion isn't assigned to that website.
3. `USED_UP`: the coupon, the promotion or the customer's own limit is reached. `GET /api/v1/admin/marketing/redemptions/:orderRef` lists an order's uses; `POST …/redemptions/release` gives them back for a cancelled order.
4. Amount-based rules need an amount for the cart's currency.

### Points look wrong

1. `GET /api/v1/admin/loyalty/customers/:id/transactions` is the ledger; the balance is always the sum of what is left on credit rows.
2. Earning and redeeming are idempotent per order reference; a repeated call changes nothing.
3. A refund reverses at most what the order earned; points already spent elsewhere are not clawed back below zero (the transaction note says how many).
4. Correct by hand with `POST /api/v1/admin/loyalty/customers/:id/adjust` (a note is required; it's in the audit log).

### A payment is stuck, or the shopper paid but the order says unpaid

1. `GET /api/v1/admin/orders/:id/payments` lists the attempts with their transactions (initiate, capture, failure, void, refund) and where each came from (`api`, `return`, `webhook`, `reconciliation`, `admin`).
2. Pending for more than 5 minutes: the reconciliation job asks the provider every 10 minutes. `POST /api/v1/admin/payments/reconcile` does it now.
3. Check that notifications arrive: `GET /api/v1/admin/payment-webhooks?status=FAILED` shows what was rejected or failed and why. `invalid-signature` means the credentials don't match the provider dashboard (Stripe/PayPal webhook secret or id, VNPay hash secret, MoMo secret key); re-enter them with `PATCH /api/v1/admin/payment-providers/:id`.
4. The provider's notification URL must be the provider's `webhookUrl` (`GET /api/v1/admin/payment-providers`), which needs `API_PUBLIC_URL` to be the public https address of the API.
5. `amount-mismatch` in the log: the provider reported a different amount than the order's. Nothing was captured; contact the provider before doing anything by hand.

### An order was charged twice, or paid after it was cancelled

The extra payment is refunded automatically through its provider (reason "The order was already paid" or "…cancelled before the payment completed"). Check `GET /api/v1/admin/orders/:id/payments`: a `FAILED` refund there needs a manual refund in the provider's dashboard (its `failureReason` says why).

### A refund failed or is pending

1. `PENDING` (Stripe, PayPal and MoMo can answer this) completes at the provider later. The reconciliation job asks about pending refunds every 10 minutes (once they are 5 minutes old) and records the outcome; `POST /api/v1/admin/payments/reconcile` asks about all of them now. While a refund is pending, its amount can't be refunded again; the order's totals, credit memo, restocking and points follow once it succeeds.
2. `FAILED`: the reason is on the refund. Fix the cause (balance at the provider, the payment is too old for an online refund, …) and post the refund again with a new `Idempotency-Key`. Refunds of cash on delivery are recorded only; pay the money back by hand.
3. Refunds never exceed what was captured minus what was already refunded, and each one goes to a single payment: split the amount when an order was paid in several payments.

### An order can't be shipped or cancelled

- Shipping needs a `PROCESSING` order: paid, or cash on delivery accepted. Unpaid orders answer "The order is not paid yet".
- Only unpaid, unshipped orders can be cancelled; a paid order is refunded instead (a full refund closes it).
- Unpaid orders are cancelled after 60 minutes by `orders-expire-unpaid`; their reserved stock, promotion uses and points are given back.

### API or worker down

1. `ShopApiDown` / `ShopWorkerDown`: Prometheus can't scrape the instance. Check the container or pod (crash loop, OOM kill, failed readiness: `GET /api/v1/health` lists the failing dependency).
2. A worker that is down stops background work: price and search indexing, webhooks, imports and exports, unpaid-order expiry, payment reconciliation. Nothing is lost: queues keep their jobs and the outbox keeps its events until a worker returns.
3. `ProcessRestarting`: look at the last logs before each restart (`level":"error"`), and at memory (`MemoryHigh`).

### Errors or slow responses

1. "Shop overview" → "p95 latency, slowest routes" shows which routes are slow; "Requests by status" shows the 5xx.
2. Every error is logged once with its request id (`x-request-id` is returned to the caller): search the logs for it.
3. Slow everywhere: check the database (connections, slow queries), Redis latency and `EventLoopLagHigh`. A long job on the API process is a bug: heavy work belongs in a worker.
4. Slow storefront reads: check the storefront cache works ("Storefront cache hits" on the dashboard; Redis healthy; `STOREFRONT_CACHE_TTL_S` > 0). Product pages and cards cache their catalog part (texts, attributes, media, URLs, variants) and read prices and stock on every request; the category tree is cached whole (`X-Cache: HIT`). Also check the price index and search are up to date (queue backlog), and that a CDN caches the storefront GETs (`Cache-Control`, `Surrogate-Key`).
5. A catalog change not visible yet: catalog after-events (products, categories, attributes, media, URLs, stores) drop the whole cache as soon as they commit. Prices and stock are never cached. Search results and CMS content are not cached by the API (their visibility windows and stock filters change without events).

### Queue backlog or failing jobs

1. "Waiting jobs per queue" shows which queue. A growing backlog means no worker runs that queue (`WORKER_QUEUES`), or it is too slow: add worker replicas for that queue group.
2. Failed jobs are kept for 7 days. Their error is in the worker logs, with the job id and queue on each line.
3. Catalog projections (prices, search, URLs) can be rebuilt any time: the `prices.reindex`, `search.reindex` and `url-rewrites.rebuild` jobs (`POST /api/v1/admin/job-executions`).

### A job, import or export failed

1. `GET /api/v1/admin/job-executions?status=FAILED` lists failed runs; `GET …/:id` shows the `error`, the counters (`stats`) and the first 100 row problems (`errors`, with CSV row numbers; the header is row 1).
2. Imports apply every valid row and report the others: fix those rows and import the file again. Imports are idempotent (they set values), so repeating one is safe.
3. "The worker running it stopped before it finished": the worker was restarted mid-run. Run it again.
4. A defined job never runs twice at once: while a run is queued or running, the next scheduled run is skipped (logged) and "run now" answers 409.
5. Export files are kept `JOBS_FILE_RETENTION_DAYS` (7) and the history `JOBS_HISTORY_DAYS` (90). Customer and order exports hold personal data: share download links, not files.

### An integration stopped receiving webhooks

1. `GET /api/v1/admin/webhooks` shows each webhook's `isActive`, `consecutiveFailures` and `disabledReason`. A webhook is switched off after `WEBHOOK_DISABLE_AFTER` (20) deliveries failed in a row (each after all its retries, about 8.5 hours), or at once when the receiver answers `410 Gone`.
2. `GET /api/v1/admin/webhooks/:id/deliveries?status=FAILED` shows the receiver's answers (`responseStatus`, `responseBody`, `error`).
3. Fix the receiver, then `PATCH /api/v1/admin/webhooks/:id { "isActive": true }` and re-send what it missed: `POST /api/v1/admin/webhook-deliveries/:id/redeliver`. `POST /api/v1/admin/webhooks/:id/test` sends a `webhook.ping`.
4. Receivers verify `X-Shop-Signature: t=<unix>,v1=<hex>`: HMAC-SHA256 of `"<t>.<raw body>"` with the webhook's secret, rejecting timestamps older than 5 minutes. `POST …/rotate-secret` issues a new secret (the old one stops at once). Deliveries are at least once: receivers de-duplicate on `X-Shop-Event-Id`.
5. Targets on private networks are refused (SSRF protection), at save time and again when connecting.

### A burst of failed sign-ins

`SignInFailureSpike` (more than 50 in 5 minutes, admin or customer). Accounts lock after `AUTH_MAX_FAILED_LOGINS`, and sign-in has a stricter rate limit (`THROTTLE_AUTH_LIMIT`). The audit log has each attempt with its IP: `GET /api/v1/admin/audit-logs?action=auth.login-failed` (admins) or `customer.login-failed`. Block the sources at the edge (WAF, CDN) if they persist.

## Scheduled jobs

| Job                             | Queue         | When         | What                                                                                                      |
| ------------------------------- | ------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `image-renditions`              | media         | on upload    | WebP renditions (200/600/1200 px) of a new image.                                                         |
| `url-rewrites-rebuild-store`    | catalog       | on demand    | Rebuilds every product and category URL of a store (store created, locales changed, manual rebuild).      |
| `price-index-rebuild`           | price-index   | on change    | Rebuilds the price index for changed variants, or everything (coalesced) after book/tax/store changes.    |
| `price-index-refresh`           | price-index   | every 5 min  | Reindexes variants whose price-book validity window opened or closed.                                     |
| `inventory-expire-reservations` | inventory     | every minute | Releases reservations past their expiry.                                                                  |
| `inventory-reconcile`           | inventory     | 03:45 UTC    | Repairs drift between `inventories.reserved` and the active reservations.                                 |
| `search-index-products`         | search-index  | on change    | Rebuilds the search documents of changed products (catalog, prices, stock) and pushes them to the engine. |
| `search-reindex-website`        | search-index  | on change    | Rebuilds a website's documents (store/attribute changes, manual reindex); coalesced.                      |
| `search-switch`                 | search-index  | on switch    | Builds the new engine's indexes, catches up, flips the active generation.                                 |
| `search-drop-indexes`           | search-index  | after switch | Drops the previous engine's indexes (`SEARCH_DROP_DELAY_MS` later).                                       |
| `scheduler-run-due`             | scheduler     | every minute | Claims due publish/unpublish schedules (SKIP LOCKED) and lets the owning module apply them.               |
| `coupons-generate`              | coupons       | on demand    | Generates a batch of unique coupon codes in chunks (resumes after a retry).                               |
| `loyalty-expire-points`         | loyalty       | 02:30 UTC    | Expires points past their expiry date (one EXPIRE transaction per credit).                                |
| `loyalty-evaluate-tiers`        | loyalty       | 03:30 UTC    | Re-evaluates tiers on the rolling window (downgrades included).                                           |
| `orders-expire-unpaid`          | checkout      | every 5 min  | Cancels orders left unpaid for 60 minutes (stock, promotion uses and points are given back).              |
| `payments-reconcile`            | checkout      | every 10 min | Asks providers about payments and refunds pending for more than 5 minutes (missed notifications).         |
| `carts-purge`                   | checkout      | 04:00 UTC    | Deletes guest carts idle for 30 days and converted or merged carts older than 90 days.                    |
| `job-run-scheduled`             | jobs          | per job cron | Queues a run of a defined job (`job:<id>` scheduler), unless its previous run is still open.              |
| `job-execute`                   | jobs          | on demand    | Runs one execution (export, import, reindex); job id = execution id.                                      |
| `jobs-requeue`                  | jobs          | every 2 min  | Re-queues executions whose message was lost; fails runs whose worker died.                                |
| `jobs-cleanup`                  | jobs          | 04:30 UTC    | Deletes export/import files after 7 days and execution history after 90.                                  |
| `webhook-deliver`               | notifications | on event     | Posts a signed webhook; retried with backoff from 1 minute (`WEBHOOK_MAX_ATTEMPTS`).                      |
| `webhooks-purge`                | notifications | 05:00 UTC    | Deletes finished webhook deliveries older than `WEBHOOK_DELIVERY_RETENTION_DAYS`.                         |
| `audit-purge`                   | maintenance   | 02:45 UTC    | Deletes audit rows older than `AUDIT_RETENTION_DAYS` (0 keeps everything).                                |
| `purge-refresh-tokens`          | maintenance   | 03:15 UTC    | Deletes refresh tokens that expired or were revoked more than 7 days ago, in batches of 5000.             |
