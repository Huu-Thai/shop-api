# shop

A headless commerce and CMS backend in the style of Magento: one catalog sold on many websites, stores and locales, with pricing, multi-country tax, inventory, search, content, marketing, loyalty and checkout behind a versioned REST API.

Built with NestJS 12 (ESM), Prisma 7 on PostgreSQL 16, BullMQ on password-protected Redis 7, S3/MinIO, and Winston. The full design and delivery plan is in [PLAN.md](PLAN.md); for operations, see [docs/RUNBOOK.md](docs/RUNBOOK.md).

**Status:** all delivery phases are done: 0 (foundation), 1 (websites, catalog, storefront contract), 2 (pricing, multi-country tax, inventory), 3 (search), 4 (CMS, navigation, merchandising, scheduler), 5 (customers, marketing, loyalty), 6 (checkout and payments) and 7 (operations: jobs, imports/exports, outgoing webhooks, metrics, dashboards, alerts, load-tested SLOs).

## Quick start

```bash
cp .env.example .env            # fill in every "change-me" (openssl rand -hex 32)
docker compose up -d            # Postgres :5434, Redis :6390 (password), MinIO :9200/:9201, Mailpit :8026
npm ci
npm run migrate:deploy
npm run build && ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' npm run admin:create
npm run seed:demo               # optional: two websites (US/EN, VN/VI+EN), every product type, tax, prices and stock
npm run start:dev               # API   → http://localhost:8082/api/v1
npm run start:worker:dev        # queue workers (separate process)
```

- Swagger UI is at `http://localhost:8082/api/docs`. Use **Authorize** with a bearer token from `POST /api/v1/admin/auth/login`, or with an API key.
- To run everything in containers (migrate job, api, worker), use `docker compose --profile app up -d --build`.
- Host ports can be changed with `SHOP_*_PORT`. The defaults avoid the ports used by the fuzzer-scanner stack.

## Architecture in one screen

| Concern | How                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writes  | Every insert or update goes through `TransactionalEventBus.write({ before, work })`. A **before** event can veto the write. **After** events go into `outbox_events` in the same transaction and are dispatched after commit. A relay re-delivers them if the process crashed. Modules talk to each other only through these events. |
| Auth    | The guard denies by default: every route declares `@Public`, `@Authenticated` or `@RequirePermissions`. Admins get a short-lived JWT plus a rotating refresh token; reusing an old refresh token revokes the whole session. Integrations use `x-api-key: shk_…` keys, which are scoped and stored only as SHA-256 hashes.            |
| RBAC    | Permissions look like `area:action`, and `area:*` or `*` grant a whole area or everything. Roles are sets of permissions. You can only grant permissions you hold yourself. The system `super-admin` role cannot be changed, and the last super-admin cannot be removed. `GET /api/v1/admin/permissions` lists the catalogue.        |
| Audit   | Every committed admin change is written to `audit_logs` with the actor, request id, IP and a field diff. `GET /api/v1/admin/audit-logs` returns them.                                                                                                                                                                                |
| Queues  | Queues are maintenance, scheduler, jobs, search-index, price-index, inventory, media, notifications, loyalty and coupons. Set `WORKER_QUEUES` so each deployment runs only the queues it should and can scale them independently.                                                                                                    |
| Errors  | Every error has the same body: `{ statusCode, message, error, path, requestId, timestamp }`. Database constraint names map to safe messages (`src/database/constraints.ts`).                                                                                                                                                         |
| Logs    | Winston writes JSON in production and pretty output in development. Every line carries the request id; secrets are redacted.                                                                                                                                                                                                         |

## Catalog model

- **One catalog, many websites.** Products, categories, attributes and images are global. A website decides what it sells (`product_websites`, `category_websites`); each store adds its own locales, currencies, country, tax display and base URL.
- **Per-store differences** live in sparse overrides (`PUT /admin/products/:id/stores/:storeId`), for example disabled in one store or a different attribute value. Texts are translated per locale, and a missing translation falls back along the locale chain (`vi-VN` → `en-US` → the store default).
- **Product types:** simple, configurable (variants per option combination, such as colour × size), bundle (options with selections), virtual and gift card. Every product sells through variants; non-configurable types have exactly one default variant, so later prices and stock always key on a variant.
- **Attributes** are typed definitions (text, number, boolean, date, select, multiselect) grouped in attribute sets. Values are JSONB on the product, or on the translation for localizable attributes, and are validated on every write.
- **URLs** are a projection per store and locale. Product URLs are `/<slug>` and category URLs are `/<parent>/<child>`. A changed slug leaves a 301 behind, and a slug that would take another page's URL is refused with 409. Admins can add custom redirects.
- **Images** go to S3/MinIO under content-addressed keys, so the same bytes are stored once. The worker renders WebP renditions at 200, 600 and 1200 px.

Modules never write each other's tables. Cross-module rules are events: for example, the products module vetoes deleting an attribute option that is still in use, and the URL module vetoes colliding slugs.

## Prices, tax and stock

- **Price books** hold unit prices per variant, in one currency each. They are entered net (US) or tax-inclusive (EU and VN), and can be scoped to a website or store, a customer group, and a date window.
- **How a price is chosen:**
  - **Matching books:** the lowest `priority` wins, then the most specific scope.
  - **Quantity tiers:** they only ever lower the price.
  - **Preview:** `GET /admin/prices/preview` shows the whole resolution for one variant.
- **The price index** is precomputed by the worker for every variant × store × customer group × currency, with net and gross amounts for the store's country. It rebuilds automatically after changes to books, tax, stores or groups; scheduled price windows are picked up every 5 minutes. Storefront reads never resolve price books themselves.
- **Tax** is calculated from classes (product and customer), zones (country, region and postcode pattern; every matching zone applies, so US state and county taxes stack) and date-effective rates (priority order, compound rates).
  - **Inclusive prices:** the gross stays exactly as entered and the net is back-calculated.
  - **Rounding:** per line, or on the total and distributed to the lines.
  - **Checkout endpoint:** `POST /admin/tax/calculate` is what checkout will use.
- **Inventory:**
  - **Sources:** warehouses supply websites in priority order. Salable stock = quantity − reserved − safety stock.
  - **Reservations:** they lock the stock rows and split across sources, so concurrent checkouts can't oversell; the database also enforces `reserved ≤ quantity`.
  - **Lifecycle:** reservations expire automatically, convert into a sale in the stock ledger, or are released. A nightly job repairs any drift in the reserved counter.
  - **Unmanaged goods:** virtual goods and gift cards don't keep stock.

## Search

- **Documents:** every product is projected into `search_documents`, one per store × enabled locale. Each holds the localized name, SKUs, searchable attribute text, facet values, price, stock and visibility.
- **Keeping it current:** the projection follows catalog, price, stock, category and store events.
- **Default engine:** Postgres full text, with per-language stemming, accent-insensitive matching ("ao thun" finds "Áo thun"), weighted ranking and search as you type.
- **Search endpoint:** `GET /api/v1/store/search` does full-text search and faceted browsing. It covers:
  - filters, the price range, the in-stock flag and sorting;
  - disjunctive facet counts: a selected value keeps its alternatives' counts;
  - category counts.
- **Suggestions:** `GET /api/v1/store/search/suggest`.
- **Other engines:** a website can use **Meilisearch, OpenSearch or Elasticsearch** instead (`PUT /api/v1/admin/search/websites/:id`, which needs `APP_ENCRYPTION_KEY`; credentials are sealed at rest and never returned).
  - **Switching:** the new engine's index is built in the background while the old one keeps serving. Changes during the build go to both, there is a catch-up pass, and then the active generation flips. Old indexes are dropped afterwards.
  - **Failures:** if an external engine fails, search answers from Postgres (with a circuit breaker).
  - **Debugging:** the `X-Search-Engine` response header says which engine answered.
- **Local Meilisearch:** `docker compose --profile search up -d` (port 7701).
- **Engine tests:** the same provider contract suite runs against every engine. Meilisearch runs in every CI build; OpenSearch and Elasticsearch run nightly (`SEARCH_PROVIDERS=opensearch,elasticsearch`).

## Content

- **Pages and blog posts** are translated, global or per store (a store's own page with the same slug wins there), and get URLs per store and locale: pages at `/<slug>` (segments allowed, e.g. `help/shipping`), posts at `/blog/<slug>`. Slugs can't take a product's or category's URL.
- **HTML is sanitized on save** (no scripts, event handlers, `javascript:` URLs or foreign iframes), so themes can render it directly.
- **Blocks** are reusable snippets. Content embeds them with `{{block id="free-shipping"}}` (rendered by the API, nested up to 3 levels, cycle-safe), and they can be placed in regions of pages, posts, categories and products. A store block overrides the global one with the same identifier.
- **Menus** link to pages, posts, categories, products or URLs; the storefront gets resolved paths, and links to hidden targets are left out.
- **Banners** (per placement, e.g. `home.hero`) and **sliders** complete the merchandising set.
- **Publishing:** pages, posts, blocks, banners and sliders are drafts until `POST …/publish` (`cms:publish`). `{"at": "…"}` schedules publishing or unpublishing. Content appears and disappears exactly on time, because storefront reads check the publishing window; the `scheduler` worker then records the change (status, audit log, URL updates). `GET /api/v1/admin/schedules` lists what is planned.

## Customers, promotions and loyalty

- **Accounts** belong to a website (the same e-mail can have an account on each). Shoppers sign up, sign in, refresh and sign out under `/api/v1/store/account/*`, with the admin's protections: lockout after repeated failures, single-use refresh tokens with reuse detection, and logout or a password change ending sessions at once. Accounts have an address book (one default shipping and one default billing address).
- **Group prices:** send the customer access token (`Authorization: Bearer …`) on catalog requests and prices follow the customer's group; those responses are `private, no-store`, while anonymous ones stay CDN-cacheable (`Vary: Authorization`).
- **Promotions** are cart price rules with typed conditions (subtotal, item quantity, customer group) and actions (percent or fixed off items or the cart, buy X get Y, free shipping), applied by priority with `stopFurther`. Some need a coupon; coupons are created one by one or generated in bulk (`coupons` worker).
- **Campaigns** gate their promotions and coupons: publish a campaign with a start and end time and everything in it applies exactly within that window.
- **Usage limits** (per promotion, per coupon, per customer) are recorded per order with `POST /admin/marketing/redemptions` (idempotent per `orderRef`, safe under concurrency) and given back with `…/redemptions/release`. `POST /admin/marketing/promotions/evaluate` previews a cart.
- **Loyalty:** one program per website (points per amount spent, point value, minimum and maximum redemption, expiry), tiers with earn multipliers over a rolling window, and an append-only ledger. Points are earned, redeemed, adjusted and reversed per order (`/admin/loyalty/customers/:id/earn|redeem|reverse|adjust`); expiry runs daily, FIFO by expiry date. Shoppers see their balance, its worth and tier progress at `GET /api/v1/store/account/loyalty`.
- Checkout records promotion uses and points when an order is placed, earns points when it is paid, and gives everything back when it is cancelled or refunded. The admin endpoints remain for integrations.

## Checkout and payments

- **Carts** (`/api/v1/store/cart/*`): a guest creates a cart with `POST /store/cart` and sends its token as `X-Cart-Token`; a signed-in customer's cart follows the session, and `POST /store/cart/merge` moves a guest cart into it on sign-in. Prices are never stored on the cart: every response is priced the way checkout charges it (tier prices, bundles, stock, promotions and coupons, shipping, tax for the destination, points). `missing` lists what still blocks the order (`email`, `shippingAddress`, `shippingMethod`, …).
- **Placing an order:** `POST /store/orders` with an `Idempotency-Key` header. Placement is a saga across modules: stock reserved → promotion uses recorded → points redeemed → order written. A failing step undoes the earlier ones, and a retry with the same key returns the same order. Guests get an `accessToken` once and send it as `X-Order-Token` to read, pay or cancel their order.
- **Payments:** `GET /store/orders/:number/payment-methods`, then `POST /store/orders/:number/payments`. The answer says what to do next:
  - `REDIRECT` (PayPal, VNPay, MoMo): send the shopper to the URL, then post the parameters the provider adds to the return URL to `POST …/payments/:id/return`;
  - `CLIENT_SECRET` (Stripe): confirm the payment with Stripe.js;
  - `NONE` (cash on delivery): the order is processed at once, and staff record the cash with `POST /admin/payments/:id/capture`.
- **Providers** are configured under `/admin/payment-providers` (credentials are encrypted with `APP_ENCRYPTION_KEY`) and offered per store with limits by currency, country and amount under `/admin/payment-methods`. Each provider's notification URL is `${API_PUBLIC_URL}/api/v1/webhooks/payments/<providerId>` (shown as `webhookUrl`). Notifications are signature-checked, recorded once per provider event, and answered in each provider's format. A job asks providers about payments and refunds still pending after 5 minutes; a refund the provider answers as pending takes effect (order totals, credit memo, restocking, points) once it completes.
- **Orders** (`/admin/orders`): shipments with tracking (`POST /admin/orders/:id/shipments`, then `…/shipments/:id/deliver`), notes, cancellation, and refunds (`POST /admin/orders/:id/refunds`, all or part, optionally by line with restocking, idempotent per `Idempotency-Key`). Invoices are issued when an order is paid and credit memos with each refund; order, invoice, credit memo and shipment numbers are sequential per website (`US-000042`, `INV-US-2026-000001`).
- **Unwanted money is returned automatically:** a payment that completes after its order was cancelled, or a second payment for an order already paid, is refunded through its provider.
- **Unpaid orders** are cancelled after 60 minutes (stock, promotion uses and points are given back).

## Operations

- **Jobs** (`/admin/jobs`, `/admin/job-executions`): exports, imports and reindexing are job types, run once (`POST /admin/job-executions`) or defined with parameters and a cron schedule in a time zone (`POST /admin/jobs`). Every run is an execution with status, progress, counters, row-level problems and, for exports, a file behind a short-lived download link. Running a type needs `jobs:write` plus that type's own permission (a customer export needs `customers:read`).
  - **Exports** (CSV, UTF-8 with BOM, spreadsheet formulas neutralised): products, prices, stock, customers, orders, audit log.
  - **Imports** (`POST /admin/imports`, multipart `file` + `type`): products (update by SKU, or create simple and virtual products), prices (per price book, decimals) and stock (counted quantities). Each row goes through the same services as the admin API; valid rows are applied, the others reported with their row number, and repeating an import is safe.
  - **Maintenance:** `search.reindex`, `prices.reindex`, `url-rewrites.rebuild`.
- **Outgoing webhooks** (`/admin/webhooks`): integrations subscribe to events (`order.*`, `payment.refunded`, `product.updated`, `job-execution.failed` …, listed at `GET /admin/webhooks/events`). Deliveries are signed (`X-Shop-Signature`, HMAC-SHA256), sent once per event and webhook, retried with backoff for about 8.5 hours, and visible with the receiver's answers; a webhook that keeps failing (or answers 410) is switched off. Private-network targets are refused.
- **Audit log:** every committed change is recorded once (`GET /admin/audit-logs`, exportable), kept `AUDIT_RETENTION_DAYS`.
- **Metrics, dashboards and alerts:** Prometheus metrics at `/api/v1/metrics` and on each worker's `:9464/metrics` (Bearer `METRICS_TOKEN`); alert rules and a Grafana dashboard live in `ops/`. `docker compose --profile app --profile monitoring up -d` runs Prometheus, Alertmanager (alerts to Mailpit) and Grafana locally. Every alert links to its section of the [runbook](docs/RUNBOOK.md).
- **SLOs and load testing:** the SLOs (storefront reads p95 ≤ 300 ms, checkout writes p95 ≤ 1 s, < 1% errors, …) are in the runbook; `loadtest/storefront.js` (k6) checks them. Product pages and cards are built from a Redis-cached catalog part (texts, attributes, media, URLs, variants; purged on every catalog change, kept at most `STOREFRONT_CACHE_TTL_S`) plus prices and stock read on every request, so pages are exact while the expensive part is served from memory; the category tree is cached whole.

## Storefront API and client

- **Endpoints** live under `/api/v1/store/*` and are public and store-scoped.
  - **Store:** chosen with the `X-Store` header or the store's domain.
  - **Locale:** chosen with `Accept-Language` or `?locale=`.
  - **Currency:** chosen with `X-Currency`.
- **Endpoints available now:**
  - `config` (the store, its locales and currencies, and the store switcher)
  - the category tree, a single category, and category listings with filters (`filter=color:red,blue&filter=size:m`) and sorting
  - the product page by id or slug, with prices (amount, net, gross, tiers, "was" price, formatted for the locale) and stock per variant; cards carry a "from" price and `inStock`
  - `url-resolver` (path → page or redirect)
  - `search` and `search/suggest`
  - account: `account/register|login|refresh|logout|password`, the profile (`account`), `account/addresses` and `account/loyalty`
  - content: `pages/by-path?path=…` and `pages/:id`, `posts` (by tag), `posts/by-slug/:slug`, `blocks/:identifier`, `blocks/placements`, `menus/:code`, `banners?placement=…` and `sliders/:code`
  - checkout: `cart` (items, coupon, e-mail, addresses, shipping method, points, merge, shipping and payment methods), `orders` (place, list, read, cancel) and `orders/:number/payments`
- **Caching:** responses carry `Cache-Control`, `Vary`, `ETag` and `Surrogate-Key` headers, so a CDN can cache them and purge precisely.
- **The contract is `openapi/storefront.json`.** CI fails when the running app differs from it.
  - **Generated client:** the typed client [`@shop/storefront-client`](packages/storefront-client/README.md) is generated from that file.
  - **Changing the API on purpose:** run `npm run contract:update` (it needs Docker) and review the diff. Within v1, changes are additive only, and `contract:update` refuses breaking changes.

## API conventions

- **Prefix:** everything lives under `/api/v1`. Admin routes are under `/admin/*`; storefront routes will be under `/store/*` from Phase 1.
- **Health:** `GET /health` is the readiness check (database, authenticated Redis, storage). `GET /health/live` is the liveness check.
- **Rate limits:** limits are per principal, or per IP when the caller is anonymous. Login and refresh have a stricter budget (`THROTTLE_AUTH_LIMIT`).
- **Request ids:** send `x-request-id` to correlate your logs; it is echoed back on every response.

## Development

| Command                           | What it does                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run check`                   | Typecheck, lint, format check, then unit tests with the coverage gate. This is what CI runs first.          |
| `npm run test:e2e`                | Testcontainers (needs Docker): migration verification, plus the app against real Postgres, Redis and MinIO. |
| `npm run migrate:dev -- --name x` | Creates a migration without applying it. Review the SQL, then run `migrate:deploy`.                         |
| `npm run migrate:diff`            | Fails if `schema.prisma` and the database have drifted apart.                                               |
| `npm run admin:create`            | Creates a super-admin, or resets its password and unlocks it (break-glass).                                 |
| `npm run ops:check`               | Lints the Prometheus alert rules and runs their unit tests (promtool, needs Docker).                        |

Conventions:

- Constraints have explicit names (`pk_`, `fk_`, `uq_`, `ix_`), and every FK column is indexed. The migration test enforces both.
- A new FK or unique constraint needs a client-safe message in `src/database/constraints.ts`, or the e2e fails.
- Imports are ESM with `.js` relative paths. Each `@OnEvent` handles exactly one event name.
- Tests use Vitest with globals. Unit tests use fakes (`src/testing/fake-bus.ts`); e2e tests boot the real app.
