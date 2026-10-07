# Shop — Backend Plan

Headless e-commerce + CMS backend in the spirit of Magento (catalog, multi-store, price books,
promotions, CMS pages/blocks, scheduled publishing), built as a professional NestJS service.

> Scope note: the request also mentioned "trigger scan via API" and "manage scanned domains". Those
> lines belong to the fuzzer-scanner spec and are left out of this plan.

---

## 0. Decisions

| #   | Decision                                                                                                                       | Why                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | **NestJS 12** (ESM), **Prisma 7.10** (latest stable; 8.x is RC), PostgreSQL 16, **BullMQ 6**, Redis 7, Node 24                 | Current stable versions; same toolchain proven in fuzzer-scanner (Vitest, oxlint, Prettier)                     |
| 2   | **Modular monolith**, two processes from one codebase: `api` (HTTP) and `worker` (queues, scheduler)                           | One deployable, clear module boundaries, independent scaling of background work                                 |
| 3   | **One NestJS module per table group** (aggregate), e.g. `products` owns `products`, `product_variants`, `product_translations` | "One module per table" taken literally gives ~70 modules for child tables; aggregates keep each module cohesive |
| 4   | **Every write**: `before` event → Prisma transaction → **transactional outbox** → `after` event                                | Listeners can veto; after-events are never lost or emitted on rollback                                          |
| 5   | Modules talk **only via events** (writes) and read-only `*Query` services (reads)                                              | No cross-module write coupling; modules can later be split into services                                        |
| 6   | **Money as integer minor units** + ISO currency code; never floats                                                             | Exact arithmetic, multi-currency safe                                                                           |
| 7   | **Translations in `*_translations` tables** keyed by locale, not JSON blobs                                                    | Indexable, searchable, Magento store-view-like fallback                                                         |
| 8   | **Multi-store from day one** (`stores` → `websites`-like): every sellable/publishable thing is scoped                          | Retrofitting scope is the most expensive Magento lesson                                                         |
| 9   | Product attributes: **typed attribute definitions + JSONB values** (not full EAV)                                              | Magento-style flexible attributes without EAV join cost; GIN-indexed filtering                                  |
| 10  | Auth: **admin JWT + RBAC**, **customer JWT** (storefront), **API keys** for integrations                                       | Three distinct audiences with different lifetimes and scopes                                                    |
| 11  | **Many websites/stores, one shared catalog** with per-website assignment and per-store overrides                               | Answer #1 (§3.3)                                                                                                |
| 12  | **Payment provider abstraction** with several providers active at once, chosen per store                                       | Answer #2 (§9.6)                                                                                                |
| 13  | **Search provider abstraction**: Postgres full-text by default; Elasticsearch, OpenSearch or Meilisearch selectable            | Answer #3 (§9.5)                                                                                                |
| 14  | **Storefront API contract-first** from Phase 1 (OpenAPI spec, generated TS client, contract tests)                             | Answer #4, since a frontend consumes it (§7.1)                                                                  |
| 15  | **All product types at launch**: simple, configurable, bundle, virtual, gift card                                              | Answer #5 (§3.2 Catalog)                                                                                        |
| 16  | **Multi-country tax**, prices tax-inclusive or exclusive per store                                                             | Answer #6 (§9.7)                                                                                                |
| 17  | **Configurable loyalty**: points per currency unit, expiry, tiers                                                              | Answer #7 (§9.8)                                                                                                |
| 18  | **S3 / MinIO** for media (same pattern as fuzzer-scanner)                                                                      | Answer #8                                                                                                       |

---

## 1. Architecture

```
            ┌──────────── api (NestJS HTTP, /api/v1, Swagger) ────────────┐
 clients ─▶ │ guards (JWT/API key, RBAC, throttling) → controllers → services│
            │   services ──bus.write()──▶ before event → $transaction ──┐   │
            │                                   outbox row (same tx) ◀──┘   │
            └──────────────┬─────────────────────────────────────────────────┘
                           │ after commit: dispatch in-process; relay re-delivers on crash
                ┌──────────┴───────────┐
        Redis (password/ACL)     PostgreSQL 16
        cache · BullMQ · locks   (Prisma, named PK/FK, partial & GIN indexes)
                ▲
            ┌───┴──────── worker (NestJS app context) ───────────────────────┐
            │ processors: scheduler, inventory, search-index, notifications,  │
            │ price-rebuild, cache-warm, coupon-generation, loyalty, exports  │
            └────────────────────────────────────────────────────────────────┘
```

**Request path, e.g. place an order:** `POST /orders` → `OrdersService.place()` → `order.before-create`
(listeners: inventory checks availability, promotions validate coupon — either may veto) →
transaction: order rows + inventory reservations + coupon redemption + outbox rows → commit →
`order.created` → listeners enqueue: payment capture, confirmation email, loyalty accrual,
search/analytics updates.

---

## 2. Project structure

```
shop/
├── src/
│   ├── main.ts / worker.main.ts / bootstrap.ts
│   ├── app.module.ts / worker.module.ts
│   ├── common/          # events (bus, outbox), guards, decorators, filters, pagination, money, i18n
│   ├── config/          # configuration.ts + Joi validation (REDIS_PASSWORD required)
│   ├── database/        # prisma schema, migrations, seed, constraint registry
│   ├── logger/          # Winston (JSON, redaction, request-id via AsyncLocalStorage)
│   ├── redis/ queue/ cache/ storage/ metrics/ health/
│   └── modules/
│       ├── stores/ locales/ currencies/                 # foundation
│       ├── catalog/  (categories, attributes)           ├── products/ (products, variants, translations)
│       ├── media/    (images, media assets)            ├── inventory/ (sources, stock, reservations)
│       ├── pricing/  (price books, entries, tax)        ├── promotions/ (rules, coupons, campaigns)
│       ├── customers/ (customers, addresses, groups)    ├── loyalty/ (accounts, tiers, ledger)
│       ├── carts/ orders/ payments/ shipments/          # checkout
│       ├── cms/      (pages, posts, blocks, placements) ├── navigation/ (menus, menu items)
│       ├── merchandising/ (banners, sliders, slides)    ├── scheduler/ (schedules)
│       ├── jobs/     (jobs, job executions)             ├── reviews/ (product reviews)
│       ├── admin/    (users, roles, permissions, api keys, audit log)
│       └── search/   (index projection, facets)
├── test/            # e2e (Testcontainers: Postgres + password-protected Redis)
├── docs/            # RUNBOOK, ADRs
└── docker-compose.yml / Dockerfile
```

Each module: `*.module.ts`, `*.controller.ts` (admin and/or storefront), `*.service.ts` (writes via
the bus), `*.query.ts` (reads others may inject), `dto/`, `events/`, `listeners/`, `processors/`, specs.

---

## 3. Database (PostgreSQL + Prisma)

### 3.1 Conventions

- **PK** `id UUID DEFAULT gen_random_uuid()`, named `pk_<table>`.
- **FK** named `fk_<table>_<column>`, explicit `ON DELETE` / `ON UPDATE`, and **every FK column indexed**.
- Unique constraints `uq_<table>_<cols>`; indexes `ix_<table>_<cols>`. All names are verified by a
  migration test (exact set, no drift).
- `created_at`, `updated_at` (timestamptz); `deleted_at` soft delete on catalog/content/customers;
  `version INT` for optimistic locking on hot rows (inventory, carts, orders).
- Money: `amount BIGINT` (minor units) + `currency_code CHAR(3)` FK to `currencies`.
- Scoped content: `store_id` FK (NULL = all stores) + translations per `locale_code`.
- Publishable things (pages, posts, blocks, banners, sliders, campaigns, promotions) share:
  `status` (`DRAFT`/`SCHEDULED`/`PUBLISHED`/`ARCHIVED`), `published_at`, `unpublished_at`.

### 3.2 Tables

✱ = requested, ✚ = suggested addition (needed for a working shop or a Magento-grade feature).

**Foundation**

| Table              | Key columns                                                                                                | Notes                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| ✚ `websites`       | code, name, default_store_id, base_currency, is_active                                                     | Magento website: groups stores, scopes product assignment, payments, tax-display |
| ✚ `stores`         | website_id, code, name, default_locale, default_currency, base_url, country, prices_include_tax, is_active | Magento store view; scopes content, locale, currency                             |
| ✱ `locales`        | code (`en-US`), name, is_active, fallback_code                                                             | Fallback chain: `vi-VN` → `en-US`                                                |
| ✚ `store_locales`  | store_id, locale_code                                                                                      | Locales enabled per store                                                        |
| ✱ `currencies`     | code (ISO 4217), symbol, minor_units, is_active                                                            |                                                                                  |
| ✚ `exchange_rates` | base, quote, rate (NUMERIC 18,8), valid_from                                                               | For display conversion; prices come from price books                             |

**Catalog**

| Table                                                   | Key columns                                                                                                                          | Notes                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| ✱ `categories`                                          | parent_id, path (materialised `a/b/c`), position, is_active, store_id                                                                | Tree via `path` + `ltree`-style index                                    |
| ✚ `category_translations`                               | category_id, locale_code, name, slug, description, meta_*                                                                            | uq(category_id, locale_code), uq(store, locale, slug)                    |
| ✱ `products`                                            | sku, type (`SIMPLE`/`CONFIGURABLE`/`BUNDLE`/`VIRTUAL`/`GIFT_CARD`), status, attribute_set_id, attributes JSONB, weight, tax_class_id | GIN on `attributes`                                                      |
| ✚ `product_translations`                                | product_id, locale_code, name, slug, short/long description, meta_*                                                                  |                                                                          |
| ✚ `product_variants`                                    | product_id, sku, option_values JSONB, is_default                                                                                     | Configurable children (size × colour)                                    |
| ✚ `product_categories`                                  | product_id, category_id, position                                                                                                    | M:N                                                                      |
| ✚ `attributes` / `attribute_options` / `attribute_sets` | code, type, is_filterable, is_required                                                                                               | Typed definitions validating the JSONB values                            |
| ✚ `product_relations`                                   | product_id, related_id, type (`RELATED`/`UPSELL`/`CROSSSELL`)                                                                        |                                                                          |
| ✚ `bundle_options` / `bundle_selections`                | product_id, title per locale, input type, is_required / option_id, child variant_id, qty, can_change_qty, price_type                 | Bundle products (Magento parity)                                         |
| ✚ `configurable_attributes`                             | product_id, attribute_id, position                                                                                                   | Which attributes (size, colour) define a configurable product's variants |
| ✚ `url_rewrites`                                        | store_id, request_path, target_type, target_id, redirect_type                                                                        | Magento URL rewrites; SEO redirects on slug change                       |

**Media**

| Table           | Key columns                                                                          | Notes                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| ✱ `images`      | storage_key, mime, width, height, bytes, alt (per locale via translations), checksum | S3 / MinIO (private bucket, presigned or CDN URLs); renditions generated by the worker; deterministic keys |
| ✚ `image_links` | image_id, owner_type, owner_id, role (`BASE`/`THUMB`/`GALLERY`), position            | One image table for products, banners, slides, posts                                                       |

**Pricing & tax**

| Table                              | Key columns                                                                                              | Notes                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ✱ `price_books`                    | code, name, currency_code, store_id, customer_group_id, priority, valid_from/to, is_active               | Magento shared catalogs / tier prices                      |
| ✚ `price_book_entries`             | price_book_id, product_id / variant_id, amount, min_qty                                                  | uq(book, variant, min_qty) → tier pricing                  |
| ✚ `tax_classes`                    | code, type (`PRODUCT`/`CUSTOMER`)                                                                        | e.g. standard, reduced, zero; retail vs business customers |
| ✚ `tax_zones` / `tax_zone_regions` | country, region, postcode pattern / range                                                                | Multi-country zones (EU, US states, VN…)                   |
| ✚ `tax_rates`                      | zone_id, product_tax_class_id, customer_tax_class_id, rate (NUMERIC 7,4), priority, compound, valid_from | Date-effective rates (rate changes don't rewrite history)  |

**Inventory**

| Table                      | Key columns                                                        | Notes                                                       |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| ✚ `inventory_sources`      | code, name, address, priority                                      | Magento MSI warehouses                                      |
| ✱ `inventories`            | source_id, variant_id, quantity, reserved, safety_stock, `version` | uq(source, variant); salable = quantity − reserved − safety |
| ✚ `inventory_reservations` | variant_id, order_id / cart_id, quantity, expires_at               | Prevents overselling; expired ones released by a job        |
| ✚ `inventory_movements`    | variant_id, source_id, delta, reason, reference                    | Append-only ledger (audit, reconciliation)                  |

**CMS & merchandising**

| Table                | Key columns                                                                                 | Notes                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ✱ `pages`            | store_id, status, layout, published_at, unpublished_at                                      | + `page_translations` (title, slug, content, meta)                                                |
| ✱ `posts`            | author_id, status, published_at, featured_image_id                                          | + `post_translations`; ✚ `post_categories`, `tags`, `post_tags`                                   |
| ✱ `blocks`           | identifier, store_id, status                                                                | + `block_translations` (content); reusable CMS snippets                                           |
| ✚ `block_placements` | block_id, target_type (`PAGE`/`POST`/`CATEGORY`/`PRODUCT`), target_id, region, position     | "A block can be injected into a post or page" — rendered at regions/shortcodes `{{block id="…"}}` |
| ✱ `menus`            | code, store_id                                                                              |                                                                                                   |
| ✱ `menu_items`       | menu_id, parent_id, position, link_type (`URL`/`PAGE`/`CATEGORY`/`PRODUCT`), target_id, url | + `menu_item_translations` (label)                                                                |
| ✱ `banners`          | placement, store_id, status, link, image_id, published_at/unpublished_at, campaign_id       |                                                                                                   |
| ✱ `sliders`          | code, store_id, status, autoplay_ms                                                         | ✚ `slides`: slider_id, image_id, position, link, caption per locale                               |

**Marketing**

| Table          | Key columns                                                                                                                         | Notes                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ✱ `campaigns`  | name, status, starts_at, ends_at, budget, channel                                                                                   | Groups promotions, banners, coupons for one marketing push |
| ✱ `promotions` | campaign_id, type (`CART`/`CATALOG`), priority, stop_further, conditions JSONB, actions JSONB, uses_per_customer, starts_at/ends_at | Magento cart/catalog price rules                           |
| ✱ `coupons`    | promotion_id, code (uq, case-insensitive), usage_limit, times_used, expires_at                                                      | ✚ `coupon_redemptions`: coupon_id, order_id, customer_id   |
| ✚ `gift_cards` | code, balance, currency, expires_at                                                                                                 |                                                            |

**Customers & loyalty**

| Table                              | Key columns                                                                                            | Notes                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| ✱ `customers`                      | email (uq per store, citext), password_hash, first/last name, customer_group_id, locale, status        |                                                                                |
| ✚ `customer_groups`                | code (`GENERAL`/`WHOLESALE`/`VIP`)                                                                     | Drives price books and promotions                                              |
| ✚ `customer_addresses`             | customer_id, type, country, region, postcode, lines, is_default                                        |                                                                                |
| ✱ `loyalties` → `loyalty_accounts` | customer_id, points_balance, tier_id                                                                   | Renamed for clarity                                                            |
| ✚ `loyalty_programs`               | website_id, currency_code, points_per_unit, redeem_rate, expiry_days, min_redeem_points, is_active     | Configurable per website                                                       |
| ✚ `loyalty_tiers`                  | program_id, code, threshold (points or spend over a window), multiplier, perks JSONB                   |                                                                                |
| ✚ `loyalty_transactions`           | account_id, delta, type (`EARN`/`REDEEM`/`EXPIRE`/`ADJUST`/`REVERSE`), order_id, expires_at, remaining | Append-only ledger; expiry consumes earn rows FIFO; balance derived and cached |
| ✚ `wishlists` / `wishlist_items`   |                                                                                                        |                                                                                |
| ✚ `product_reviews`                | product_id, customer_id, rating, title, body, status (moderated)                                       |                                                                                |
| ✚ `newsletter_subscriptions`       | email, store_id, status, consent_at                                                                    | GDPR consent trail                                                             |

**Checkout**

| Table                                             | Key columns                                                                                                                   | Notes                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ✚ `carts` / `cart_items`                          | customer_id or guest token, store, currency, coupon, `version`                                                                |                                                               |
| ✚ `orders` / `order_items` / `order_addresses`    | number (uq), status, totals (subtotal, discount, tax, shipping, grand), currency, idempotency_key (uq)                        | Line items snapshot names/prices (never re-read from catalog) |
| ✚ `payment_providers`                             | code (`stripe`/`paypal`/`vnpay`/`momo`/`adyen`/`cod`…), credentials (encrypted), mode (`TEST`/`LIVE`), is_active              | One row per configured provider account                       |
| ✚ `store_payment_methods`                         | store_id, provider_id, method (`CARD`/`WALLET`/`BANK_TRANSFER`/`COD`…), position, min/max order, allowed countries/currencies | Several providers per store, ordered                          |
| ✚ `payments` / `payment_transactions` / `refunds` | order_id, provider_id, provider_ref, amount, status / type (`AUTHORIZE`/`CAPTURE`/`VOID`/`REFUND`), raw response              | Full transaction trail                                        |
| ✚ `payment_webhook_events`                        | provider_id, provider_event_id (uq), payload, processed_at                                                                    | Idempotent webhook handling                                   |
| ✚ `shipments` / `shipment_items`                  | carrier, tracking, status                                                                                                     |                                                               |
| ✚ `invoices` / `credit_memos`                     |                                                                                                                               | Accounting documents (Magento parity)                         |

**Operations**

| Table                                                  | Key columns                                                                                                                                            | Notes                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| ✱ `jobs`                                               | type (`IMPORT`/`EXPORT`/`REINDEX`/`PRICE_REBUILD`/…), schedule (cron), params JSONB, is_active                                                         | Admin-defined recurring jobs                                                  |
| ✱ `job_executions`                                     | job_id, status, started_at, finished_at, stats JSONB, error                                                                                            |                                                                               |
| ✱ `scheduler` → `schedules`                            | target_type (`PAGE`/`POST`/`BANNER`/`SLIDER`/`CAMPAIGN`/`PROMOTION`/`BLOCK`), target_id, action (`PUBLISH`/`UNPUBLISH`), run_at, status, executed_at   | One generic table, polymorphic target; a partial index on pending rows        |
| ✚ `admin_users` / `roles` / `permissions` / `api_keys` |                                                                                                                                                        | RBAC, hashed keys                                                             |
| ✚ `audit_logs`                                         | actor, action, entity, entity_id, before/after JSONB                                                                                                   | Who changed what (from after-events)                                          |
| ✚ `outbox_events`                                      | event_name, payload, origin, attempts, available_at, failed_at                                                                                         | Transactional outbox                                                          |
| ✚ `search_documents`                                   | store_id, locale_code, entity_type, entity_id, document JSONB, tsv tsvector, updated_at                                                                | Postgres full-text index (GIN on `tsv`); also the source for external engines |
| ✚ `search_settings`                                    | scope (global or website), provider (`POSTGRES`/`ELASTICSEARCH`/`OPENSEARCH`/`MEILISEARCH`), connection (encrypted), index_prefix, synonyms, stopwords | Selects the engine; switching triggers a full reindex                         |
| ✚ `webhooks` / `webhook_deliveries`                    |                                                                                                                                                        | Notify ERPs, marketplaces                                                     |

Polymorphic references (`schedules.target_id`, `image_links.owner_id`, `block_placements.target_id`)
cannot be real FKs. They are validated in the before-event, and a nightly consistency job cleans up
orphans. Everything else is a real, named FK.

### 3.3 Multi-store with a shared catalog

- **One catalog**: `products`, `categories`, `attributes` and `images` are global rows.
- **Website assignment**: `product_websites` (product_id, website_id) and `category_websites` decide
  where something is sold or shown. The same product can live on many websites.
- **Per-store overrides without copying**: translations are per locale; and a sparse
  `product_store_overrides` table (product_id, store_id, status, visibility, attributes JSONB patch)
  holds only what differs, e.g. disabled in one store or a store-specific attribute. Resolution order:
  store override → website default → global.
- **Prices** come from price books scoped by website/store, currency and customer group, so the same
  catalog sells in VND on one site and USD/EUR on another.
- **Inventory**: sources are linked to websites (`website_inventory_sources`, priority), so stores share
  or split stock.
- **Content** (pages, posts, blocks, menus, banners, sliders) is store-scoped, with `store_id` NULL meaning
  shared by all stores.
- Every storefront request resolves its store from the `X-Store` header or the domain → `stores.base_url`;
  every query is filtered by it (a Prisma extension enforces the scope, so a forgotten filter cannot leak
  another store's data).

---

## 4. Transactions & events

```ts
await bus.write({
  before: new ProductBeforeUpdateEvent(id, dto, actor), // listeners may throw to veto
  work: async (tx, after) => {
    const p = await tx.product.update({ where: { id, version }, data });
    after.add(new ProductUpdatedEvent(p.id, changedFields, actor)); // written to outbox in tx
    return p;
  },
});
```

- Before-listeners validate and may veto (`suppressErrors: false`); they never write.
- After-events are stored in `outbox_events` inside the transaction and dispatched after commit; a
  relay re-delivers them if the process dies first. Listeners are idempotent.
- **Event catalogue (extract):**

| Event                                 | Listeners                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `product.updated` / `product.deleted` | search index, cache invalidation, url_rewrites, audit                                           |
| `price-book.entry-changed`            | price index rebuild (queue), cache                                                              |
| `inventory.changed`                   | salable qty cache, back-in-stock notifications, search (in-stock facet)                         |
| `order.created`                       | inventory (convert reservation), payments, loyalty accrual, coupon redemption, email, analytics |
| `order.cancelled` / `refund.created`  | inventory release, loyalty reversal                                                             |
| `schedule.due`                        | target module publishes/unpublishes, then `page.published` etc.                                 |
| `page.published` / `block.updated`    | CDN/page cache purge, sitemap rebuild                                                           |
| `customer.registered`                 | loyalty account, welcome email, newsletter consent                                              |
| `campaign.started` / `campaign.ended` | activate/deactivate its promotions, banners, coupons                                            |

---

## 5. Queues (BullMQ)

| Queue           | Jobs                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| `scheduler`     | Every minute: claim due `schedules` (`FOR UPDATE SKIP LOCKED`) → `schedule.due` |
| `jobs`          | Run admin-defined jobs (imports, exports, reindex) → `job_executions`           |
| `search-index`  | Re-project products/categories into the search index                            |
| `price-index`   | Rebuild effective prices per store/group/currency after price-book changes      |
| `inventory`     | Release expired reservations; reconcile ledger vs stock                         |
| `media`         | Image renditions (sharp), CDN upload                                            |
| `notifications` | Emails/SMS (transactional + marketing), webhooks                                |
| `loyalty`       | Accrual/expiry of points                                                        |
| `coupons`       | Bulk coupon generation                                                          |

Every job is idempotent (deterministic job ids), with attempts, backoff, and `removeOn*` retention.
Workers select queues with `WORKER_QUEUES` so groups scale independently.

---

## 6. Redis (password required) & caching

- `REDIS_PASSWORD` is **mandatory**; config validation fails without it (≥ 16 chars in production). ACL user
  `REDIS_USERNAME` and `REDIS_TLS` are supported. Separate logical DBs (or prefixes) for queues and cache.
- Cache-aside with namespaced keys (`cache:product:{store}:{locale}:{id}`, `cache:menu:{store}:{locale}:{code}`,
  `cache:price:{variant}:{store}:{group}:{currency}`), invalidated **by after-events**, never by TTL alone.
- Stampede protection (single-flight lock), and a short negative cache for 404s.
- Distributed locks for checkout per cart and for scheduler leadership.

---

## 7. API (`/api/v1`, Swagger at `/api/docs`)

Two surfaces from one app, separated by route prefix and guard:

| Surface      | Prefix            | Auth                                                            | Examples                                                           |
| ------------ | ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Admin        | `/api/v1/admin/*` | Admin JWT + RBAC (`catalog:write`, `cms:publish`…)              | CRUD for every table, bulk import/export, publishing, schedules    |
| Storefront   | `/api/v1/store/*` | Anonymous / customer JWT; `X-Store` + `Accept-Language` headers | catalog browse/search, CMS by slug, menus, cart, checkout, account |
| Integrations | `/api/v1/admin/*` | API key (scoped, hashed)                                        | ERP sync, webhooks                                                 |

### 7.1 Storefront contract (consumed by a Next.js theme)

Because a frontend depends on it from day one, the storefront API is designed **contract-first**:

- `openapi/storefront.yaml` is reviewed before implementation. CI fails if the running app's Swagger
  differs from it (contract test), and a typed TS client (`@shop/storefront-client`) is generated for
  the theme.
- **Read models shaped for pages, not tables**:
  - `GET /store/pages/by-slug/:slug` returns content with blocks already resolved;
  - `GET /store/products/by-slug/:slug` returns the product with resolved price, salable qty, variants
    matrix, bundle options, images and breadcrumbs;
  - `GET /store/categories/:id/products` returns a listing with facets;
  - `GET /store/menus/:code`, `GET /store/banners?placement=`, `GET /store/sliders/:code`, and
    `GET /store/config` (store, locales, currencies, tax display, payment methods).
- **Stable, additive evolution**: fields are only added within `v1`, removals require `v2`, and
  deprecated fields carry `Deprecation` headers for one release.
- **Caching-friendly**: storefront GETs return `ETag`, `Cache-Control` and surrogate keys (e.g.
  `product:123`), so a CDN can purge precisely on after-events.
- **Locale and currency negotiation**: `Accept-Language` and `X-Currency` with fallbacks; every price
  object carries `amount`, `currency`, `formatted`, `includesTax`.
- **Cart and checkout**: guest carts are identified by an opaque token and merged into the customer's
  cart on login. Checkout steps are explicit resources (address, shipping method, payment method, place
  order) so any frontend can build a one-page or multi-step flow.

Conventions: DTO validation (class-validator, whitelist), pagination (`page/limit` + cursor for big
lists), filtering and sorting allowlists, `Idempotency-Key` on order and payment POSTs, ETag/`If-Match`
with `version` for optimistic concurrency, RFC 7807-style error bodies with request id, and per-key and
per-IP rate limits (stricter on login and checkout).

---

## 8. Logging (Winston)

JSON logs with `requestId`, `actor`, `store`, `jobId`. Secrets and PII (passwords, tokens, card data,
emails in production) are redacted. Request log line with duration and status; daily rotation option;
log level per environment.

---

## 9. Domain logic worth designing up front

- **Price resolution** (Magento-like): candidate entries from active price books matching store,
  currency, customer group and date → lowest `priority`, then tier by `min_qty` → catalog promotions →
  cart promotions → coupon → tax. The result is precomputed into a price index by the worker and served
  from cache.
- **Promotion engine:** conditions/actions JSONB with a typed schema (cart subtotal ≥ X, SKU in set,
  customer group, first order…; percent / fixed / buy-X-get-Y / free shipping). Evaluated in priority
  order with `stop_further`. The applied rules are snapshotted on the order.
- **Scheduler:** `schedules` rows; the worker claims due rows with a lease, emits `schedule.due`, and the
  owning module flips status in its own transaction. Publish and unpublish are just two schedule rows.
- **Blocks in content:** the stored content keeps `{{block id="hero-usp"}}` tokens. At render, the
  storefront API resolves tokens + `block_placements` for the page/post region (cached per
  store/locale and invalidated on `block.updated`). Recursive blocks are limited in depth (3).
- **Inventory:** reserve on checkout start (TTL 15 min), convert on payment, release on expiry or
  cancel. Optimistic locking on `inventories.version`.

### 9.5 Search provider abstraction

```ts
interface SearchProvider {
  index(docs: SearchDocument[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(q: SearchQuery): Promise<SearchResult>; // text, filters, facets, sort, page
  suggest(q: string, ctx: StoreCtx): Promise<Suggestion[]>;
  health(): Promise<void>;
}
```

- **PostgresSearchProvider (default)**: queries `search_documents` with `tsvector` per locale
  (language-specific dictionaries where Postgres has one, `simple` + unaccent otherwise), `ts_rank`,
  GIN-indexed filters on JSONB attributes, and facets via `GROUP BY` on a filtered CTE. This is good for
  small and medium catalogs.
- **ElasticsearchProvider / OpenSearchProvider / MeilisearchProvider**: the same interface. Indexes are
  named `{prefix}_{store}_{locale}`, with mappings generated from `attributes` (filterable → keyword,
  searchable → text with an analyzer per locale).
- **Selection**: `search_settings` per website, editable in admin. Switching providers builds the new
  index in the background and swaps it in only when complete (alias swap / dual-read). The storefront
  keeps working on the old engine meanwhile.
- **Indexing**: `search-index` queue jobs, fed by after-events (`product.updated`, `price-index.rebuilt`,
  `inventory.changed`…), with a full reindex job. `search_documents` is always maintained, so Postgres
  remains a fallback if an external engine is down (circuit breaker).

### 9.6 Payments: multiple providers

```ts
interface PaymentProvider {
  createIntent(order, method): Promise<PaymentIntent>;          // redirect URL / client secret / QR
  authorize?(…); capture(…); void(…); refund(…);
  parseWebhook(headers, rawBody): Promise<ProviderEvent>;       // verifies the signature
}
```

- Adapters live in a registry. Planned: **Stripe**, **PayPal**, **Adyen**, **VNPay**, **MoMo**, **bank
  transfer**, and **cash on delivery**. A buyer can add one by implementing the interface and
  registering it.
- `store_payment_methods` decides what each store offers (by country, currency and order amount).
  Checkout lists the eligible methods.
- **Idempotency everywhere**:
  - the order `Idempotency-Key`;
  - provider idempotency keys derived from payment id + attempt;
  - webhooks de-duplicated on `provider_event_id`.
- A **reconciliation job** compares provider settlement reports with `payment_transactions`.
- Credentials are encrypted at rest (AES-GCM, key from env/KMS). No card data is ever stored
  (provider-hosted fields / redirects keep the shop in PCI DSS SAQ-A scope).

### 9.7 Multi-country tax

- The tax address (shipping, or billing for virtual goods) is matched to a **zone**. The rate then comes
  from zone × product tax class × customer tax class, effective at the order date. Compound and
  priority rules are supported.
- `stores.prices_include_tax` decides whether catalog prices are entered and shown tax-inclusive (EU,
  VN) or exclusive (US). The engine back-calculates net amounts for inclusive prices, so totals stay
  exact.
- Rounding is per line or per total (configurable per country) on integer minor units, with the
  remainder distributed to the last line.
- Tax lines are **snapshotted on the order** (rate, zone, amounts), so later rate changes never alter
  past orders.
- A `TaxCalculator` interface leaves room for external engines (Avalara, TaxJar) in the US.

### 9.8 Loyalty

- **Earn**: on `order.paid`, points = floor(eligible net amount / unit) × tier multiplier, per website
  program. They are reversed on refund or cancel.
- **Redeem**: points convert to a discount at `redeem_rate` during checkout. This is a reservation
  first; it's committed when the order is placed.
- **Expiry**: earned points expire after `expiry_days`, FIFO from the ledger. A daily job writes `EXPIRE`
  transactions, and customers are notified 30 days ahead.
- **Tiers**: evaluated nightly on rolling spend or points. Tier changes emit
  `loyalty.tier-changed`, which other modules can use for promotions or free shipping.

---

## 10. Testing

- **Unit (Vitest):** every service — happy path, not found, before-event veto, after-events only on
  commit; the price and promotion engines with table-driven cases; DTO validation.
- **e2e (Testcontainers):** Postgres + Redis **with password**. Covers: catalog CRUD, publish by schedule,
  cart → order → inventory, coupon limits under concurrency, auth/RBAC.
- **Migration test:** named PK on every table, the exact FK set with actions, every FK indexed, no
  schema drift.
- **Contract tests:** the running app's OpenAPI must match `openapi/storefront.yaml`; the generated
  client compiles.
- **Provider suites:** the same test suite runs against every `SearchProvider` (Postgres in CI;
  Elasticsearch, OpenSearch and Meilisearch via Testcontainers in a nightly job) and every
  `PaymentProvider` (sandbox mocks plus signed webhook fixtures).
- **Tax:** table-driven cases per country (inclusive and exclusive prices, rounding, compound rates).
- **Coverage gate:** 80% lines / 75% branches.

---

## 11. DevOps

docker-compose (Postgres, Redis with `requirepass`, MinIO, Mailpit), multi-stage Dockerfile
(`api`, `worker`, `migrate` targets, non-root, healthcheck), migrations as a release job, CI (lint,
typecheck, unit, e2e, migration test, image scan), Prometheus metrics, health endpoints, and a runbook.

---

## 12. Scale-up recommendations

| Concern             | Recommendation                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Catalog reads       | Price index + Redis cache + CDN for storefront GETs; read replica for storefront queries                          |
| Search              | OpenSearch/Meilisearch fed by `search-index` jobs (facets, typo tolerance, synonyms)                              |
| Checkout contention | Short transactions, row-level locks only on inventory rows, reservations instead of decrement-on-add              |
| Flash sales         | Queue-based checkout admission, pre-warmed caches, per-SKU reservation counters in Redis (reconciled to Postgres) |
| Write volume        | PgBouncer; partition `orders`, `inventory_movements`, `audit_logs` by month once large                            |
| Background work     | Per-queue worker deployments, KEDA autoscaling on queue depth                                                     |
| Multi-region        | Read replicas per region; writes stay single-region until order volume demands sharding by store                  |

## 13. Feature expansion ideas

1. **Search & merchandising:** visual merchandising (pin, boost, bury), synonyms, search analytics.
2. **Personalisation:** recently viewed, recommendations (co-purchase), segment-targeted banners and
   promotions.
3. **B2B:** company accounts, quotes, purchase orders, shared catalogs (price books per company),
   credit limits.
4. **Subscriptions** and recurring orders.
5. **Omnichannel:** BOPIS / ship-from-store using inventory sources; marketplace feeds (Google
   Shopping, Meta).
6. **Content:** page builder JSON (blocks as components), preview links, versioning and rollback,
   A/B tests.
7. **Customer service:** RMA/returns workflow, order editing, notes and timeline.
8. **Compliance:** GDPR export/erase, cookie consent, VAT/OSS reporting.
9. **AI assist:** generated product descriptions and SEO metadata per locale, review summarisation,
   fraud scoring on orders.

---

## 14. Delivery plan

| Phase                                          | Scope                                                                                                                                                                                                                                                                                   | Estimate | Done when                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| **0. Foundation**                              | Nest scaffold, config + Joi (Redis password), Winston, Prisma + migration test, Redis/BullMQ, event bus + outbox, auth (admin JWT + RBAC + API keys), Swagger, health, compose (Postgres, Redis, MinIO, Mailpit), CI                                                                    | 5 d      | Health green with authenticated Redis; migration test passes                                                       |
| **1. Websites, catalog & storefront contract** | websites/stores, locales, currencies, store scoping extension; categories, attributes, all product types (simple, configurable, bundle, virtual, gift card), website assignment + store overrides, images on S3/MinIO, url rewrites; **storefront OpenAPI v1 draft + generated client** | 10–12 d  | The same catalog is sold on two websites in two locales; the theme team can code against the generated client      |
| **2. Pricing, tax & inventory**                | price books + entries + price index, multi-country tax engine, inventory sources per website, reservations, ledger                                                                                                                                                                      | 8–9 d    | Correct net/gross price per store, group, currency and qty for EU/US/VN fixtures; no overselling under concurrency |
| **3. Search**                                  | `search_documents` + Postgres FTS provider (facets, suggest); provider interface; Elasticsearch, OpenSearch and Meilisearch adapters; provider switch with background reindex                                                                                                           | 6–7 d    | Storefront search works on Postgres; switching to Meilisearch/OpenSearch reindexes without downtime                |
| **4. CMS & merchandising**                     | pages, posts, blocks + placements, menus, banners, sliders, schedules + scheduler                                                                                                                                                                                                       | 6–7 d    | Content and banners publish/unpublish on schedule; blocks render inside pages and posts                            |
| **5. Marketing, customers & loyalty**          | customers, groups, addresses, campaigns, promotion engine, coupons, loyalty programs/tiers/ledger                                                                                                                                                                                       | 8–9 d    | A campaign activates promotions and coupons; points earn, redeem, expire and reverse on refund                     |
| **6. Checkout & payments**                     | carts (guest merge), checkout resources, orders, payment provider registry + Stripe, PayPal, VNPay, MoMo, COD, webhooks, reconciliation, shipments, invoices, refunds                                                                                                                   | 10–12 d  | Cart → order → payment (each provider in sandbox) → shipment → refund end to end in e2e                            |
| **7. Ops & hardening**                         | jobs + executions, imports/exports, audit log, webhooks out, metrics, load test, runbook                                                                                                                                                                                                | 5–6 d    | Load-test SLOs met; dashboards and alerts live                                                                     |

Total about 58–67 working days. The storefront contract lands in Phase 1, so frontend work can start in parallel.

### Status

**Phase 0 — done (2026-10-03).**

- Done criterion met: `GET /api/v1/health` is green against password-protected Redis (the e2e also proves Redis rejects clients without the password), and the migration test passes (no schema drift, PK/FK/unique naming, FK indexes, referential actions).
- Verified live in the containerised stack (`docker compose --profile app`): migrate → api + worker healthy → `admin:create` → login → `/me` → audit log.
- Tests: 111 unit (90% lines / 80% branches) + 24 e2e (Testcontainers: Postgres 16, Redis with password, MinIO). `npm audit`: 0 vulnerabilities.
- Delivered beyond the original scope line:
  - Admin auth: rotating refresh tokens with reuse detection (theft revokes the whole session), instant logout via Redis, lockout, scrypt, password policy.
  - RBAC: deny-by-default guard, `area:*` wildcards, no privilege escalation (you can only grant what you hold), immutable system role, last super-admin protected.
  - API keys shown once and stored as SHA-256 only; audit log for every committed admin change (actor, request id, IP, diff).
  - `npm run admin:create` break-glass CLI; daily refresh-token purge job.
- Bug found by tests and fixed: Joi `.valid()` bypassed the production minimum for `PASSWORD_SCRYPT_N`; each environment now has its own allow-list.
- Deferred to Phase 1: the `seed` script (stores, locales, currencies are Phase 1 reference data).

**Phase 1 — done (2026-10-03).**

- **Done criterion met:** the e2e `test/catalog.e2e-spec.ts` sells one catalog on two websites (US/en-US/USD and VN/vi-VN+en-US/VND/tax-inclusive) and checks:
  - localized trees, listings, product pages, bundles and gift cards;
  - store overrides, website-only products, and filters on configurable variants;
  - per-locale URLs with 301s after renames and category moves;
  - the veto events, and image upload → worker WebP renditions;
  - CDN headers and ETag/304.
- **Theme team:** they can code against `@shop/storefront-client`, generated from the reviewed contract `openapi/storefront.json`. CI fails if the running app drifts from the contract or the client is stale.
- **Schema:** migration `0003_catalog_foundation` adds 30 tables, CHECK constraints and ISO reference data (30 currencies, 18 locales with fallbacks, a `default` attribute set). The migration test pins all 53 FKs with their actions.
- **Modules:** `stores` (with the StoreContext guard and cached snapshot), `catalog` (attributes, sets, categories), `products` (all five types, variants, bundles, overrides, relations), `media`, `url-rewrites`, and `storefront` (read models only).
- **Cross-module rules are events:**
  - `products` vetoes removing attribute options in use, and image links to unknown products or variants;
  - `url-rewrites` vetoes colliding slugs and rebuilds URLs after catalog events;
  - `media` cleans up links when an owner is deleted and queues renditions.
- **Tests:** 266 unit (95% lines, 85% branches; thresholds ratcheted to 92/82) and 50 e2e. Verified live in containers: migrate → `seed:demo` → storefront requests, with no outbox backlog.
- **Bugs found and fixed:**
  - Name sorting compared raw bytes ("Bộ" before "Áo"); listings now sort with the ICU root collation.
  - Shutdown disconnected Prisma before draining after-commit deliveries. The dispatcher now drains in `onModuleDestroy`, looping for cascading listeners, and Prisma disconnects in `onApplicationShutdown`.
- **Decisions and deviations from the plan:**
  - **Store scope:** enforced by types (every storefront read takes a `StoreContext`) instead of a Prisma query extension, which would silently rewrite queries. Leak checks are in the e2e.
  - **Contract format:** JSON (`openapi/storefront.json`) instead of YAML, generated from the app and reviewed in PRs.
  - **Category subtree queries:** use `path LIKE`, with no pattern-ops index (Prisma can't model one without perpetual drift; category tables are small).
  - **SKUs:** unique across products and variants together; the only shared SKU is a single-variant product and its default variant.
  - **Facets** (counts per filter value) come with search in Phase 3. Phase 1 listings filter but don't count.
  - **Prices and salable quantity** are added to the product DTOs in Phase 2. Within v1 that is an additive contract change.
  - **openapi-typescript 7** declares a TypeScript 5 peer; a scoped `overrides` entry points it at TypeScript 6. Generation and compilation are verified in CI.

**Phase 2 — done (2026-10-03).**

- **Done criterion met:** `test/pricing-inventory.e2e-spec.ts` (real API + worker) checks prices for US (net, sale book over list, quantity tier), Germany (inclusive: €29.99 → net €25.20 at 19%; books at 7%), Vietnam (VND 599.000 → net 544.545; shown in USD via the exchange rate), and the wholesale group (its own net book; a line of 3 = €60.00 + €11.40 tax). It also checks tax for Los Angeles (state 7.25% + county 2.25%).
- **No overselling:** 40 concurrent reservations against 10 units → exactly 10 succeed, 30 get 409, and stock ends at reserved 10 / salable 0. Then convert → ledger SALE, release, expiry and reconciliation are verified.
- **Schema:** migration `0004_pricing_tax_inventory` adds 13 tables (80 FKs pinned in the migration test), CHECKs (`reserved ≤ quantity` is the oversell guard), and seeds tax classes and customer groups. The stock ledger RESTRICTs deletion of sources and variants that have history.
- **Modules:**
  - `tax`: a pure BigInt engine with zones, stacked and compound rates, inclusive back-calculation and LINE/TOTAL rounding;
  - `customers`: customer groups;
  - `pricing`: books, tiers, exchange rates, the indexer, preview and storefront query;
  - `inventory`: sources, ledger, locked reservations, expiry and reconcile jobs.
- **Storefront:** cards and product pages gain `price`/`inStock`, variants gain `price`/`stock`, bundles get a "from" price over required options. These are additive contract changes, and `contract:update` now refuses breaking ones.
- **Tests:** 339 unit (96% lines, 86% branches; thresholds ratcheted to 94/84) and 65 e2e. Verified live in containers: seed → worker indexes prices → storefront prices and stock in USD and VND.
- **Bugs found and fixed:**
  - Background jobs read a configuration cache up to 5 s stale, which indexed new stores/tax rates wrongly. A stale store could even make a Phase 1 store URL rebuild delete its URLs. Rebuilds now read configuration fresh.
  - Full rebuilds were de-duplicated by jobId, which silently dropped requests while a completed job with that id was kept. They now use generation-based coalescing (a burst collapses into one run, and a change during a rebuild always gets its own run). The Phase 1 store URL rebuild had the same flaw and was fixed the same way.
- **Decisions:**
  - **Storefront group:** shoppers price as the `guest` group until customers sign in (Phase 5).
  - **Display tax:** the index stores gross for the store's country; checkout recalculates with the real address via the same engine.
  - **Unmanaged stock:** virtual goods, gift cards and bundles (whose availability comes from their selections) don't keep stock.
  - **Coverage scope:** `src/cli/**` is excluded from unit coverage (it is exercised by the live check).

**Phase 3 — done (2026-10-03).**

- **Done criterion met:** `test/search.e2e-spec.ts` runs one behaviour suite on Postgres and, after a live switch, on Meilisearch, asserting the answering engine (`X-Search-Engine`) for every request. The suite covers:
  - ranking, search as you type, searchable attributes, exact SKUs and accent-insensitive Vietnamese;
  - disjunctive facets, category browsing, catalog/search visibility, price filter, range and sort, in-stock, paging and suggestions.
- **No downtime during the switch:** every search during the build succeeded with full results. Changes made afterwards reached Meilisearch, stopping Meilisearch fell back to Postgres, and switching back to Postgres needs no build.
- **Provider contract suite** (`test/search-providers.e2e-spec.ts`): Meilisearch passes in every build. OpenSearch 2.19 and Elasticsearch 8.17 also passed it live and run in a nightly workflow.
- **Schema:** migration `0005_search` adds `search_settings` (per website, sealed connections, active/pending generations) and `search_documents` (JSONB + weighted `tsvector`, GIN indexes), plus `shop_unaccent()` (IMMUTABLE) and `shop_search_config(locale)`.
- **Module `search`:**
  - a document builder fed by the same read models as the storefront;
  - an indexer driven by product, price-index, inventory, category, store and attribute events, writing through the bus;
  - engine adapters over plain HTTP (no SDKs);
  - disjunctive facets implemented once for all engines;
  - a zero-downtime switch (build → catch-up → flip → catch-up → delayed drop);
  - a circuit breaker with Postgres fallback;
  - `SecretsService` (AES-GCM, `APP_ENCRYPTION_KEY`) for credentials.
- **Storefront:** `GET /store/search` and `/store/search/suggest`, as additive contract changes (the breaking-change guard passed), with client types `SearchResult`, `Facet` and `Suggestion`.
- **Tests:** 370 unit (96.7% lines, 86.6% branches; thresholds ratcheted to 95/85) and 89 e2e. Verified live in containers: seed → search on Postgres → switch the US website to Meilisearch via the admin API → search on Meilisearch, with the VN website still on Postgres.
- **Found and fixed:**
  - Meilisearch reports deleting a missing index as an asynchronous failed task; recreating an index now tolerates exactly `index_not_found`.
  - Postgres ignored synonyms, so results differed by engine. Single-word synonyms now expand query terms on Postgres too.
- **Decisions:**
  - **Visibility:** a text query searches products visible in SEARCH/CATALOG_SEARCH; browsing without text uses CATALOG/CATALOG_SEARCH.
  - **Prices in search:** price facets and filters use the store's default currency and the guest group.
  - **Engine handover:** after a flip, the API serves the old engine for up to its 5 s configuration cache; both engines hold the same documents, so results stay correct.
  - **Indexer performance:** the indexer reuses the storefront read models per product × store × locale (correct, but query-heavy). Batching is listed for Phase 7 hardening.

**Phase 4 — done (2026-10-04).**

- **Done criterion met:** `test/cms.e2e-spec.ts` (real API on Postgres, Redis with password and MinIO) checks:
  - a page scheduled 2.5 s ahead is hidden (and its reserved URL doesn't resolve), appears exactly on time before the scheduler has run, and the scheduler then records `PUBLISHED` with a `page.published` audit entry by the system;
  - a banner with a publish and an unpublish time is shown only inside that window, then archived by the scheduler (`PUBLISH:DONE`, `UNPUBLISH:DONE`);
  - blocks render inside pages and posts (nested, cycle-safe, drafts and unknown blocks render nothing, store blocks override global ones), and placed blocks come back by region for pages and categories;
  - sanitized HTML, page/post URLs per store and locale, slug collisions with the catalog refused, a store page shadowing a global one, URLs for a store created later, menus with resolved links (hidden targets dropped), sliders.
- **Schema:** migration `0006_cms` adds 19 tables (116 FKs pinned in the migration test) with CHECKs (publish window order, slug/identifier formats, menu link shape, schedule state), partial uniques per scope (global vs store) and one pending schedule per target and action.
- **Modules:**
  - `scheduler`: owns `schedules`; mirrors requested state, claims due rows with `FOR UPDATE SKIP LOCKED` every minute and emits `schedule.due`;
  - `cms`: pages, posts, tags, blocks and placements, the block renderer, sanitize-on-save, URL sync through `url-rewrites` (no import cycle) and a URL veto;
  - `navigation`: menus and item trees (depth ≤ 5, no cycles); items linking to deleted pages, posts or categories are deactivated;
  - `merchandising`: banners and sliders.
  - A shared `ContentPublisher` gives every content type the same publish/unpublish/due logic.
- **Storefront:** pages (by path or id), posts (list by tag, by slug, by id), blocks and placements, menus, banners and sliders, all additive contract changes (the breaking-change guard passed), with client types `Page`, `Post`, `Block`, `Menu`, `Banner`, `Slider` and friends. The URL resolver now also answers pages and posts, but only while they are visible.
- **Tests:** 427 unit (97.4% lines, 88.6% branches) and 104 e2e across 7 suites. Verified live in containers: seed (pages, post, block, menus, banner, slider) → storefront content in en-US and vi-VN → a scheduled page published by the real worker's scheduler job, with no outbox backlog.
- **Found and fixed:** publishing events were named by visibility, so a due schedule for content already visible by the clock emitted `scheduled` instead of `published`. Events are now named by status transition.
- **Decisions:**
  - **Time-based visibility:** storefront reads check `published_at`/`unpublished_at` against the clock; the scheduler only moves the status and announces it. Content is therefore on time even when workers lag, and pending schedules mirror the content's state, so a stale schedule is a no-op.
  - **One publishing API:** `POST …/publish` and `…/unpublish` with an optional `at`; there is no separate "cancel schedule" endpoint (unpublishing a scheduled item returns it to draft and cancels its schedule). Publishing needs `cms:publish`, editing `cms:write`.
  - **URLs:** content on the publishing track keeps its URL (so its slug is reserved); the resolver hides it until it is visible. Pages live at `/<slug>` (segments allowed), posts at `/blog/<slug>`.
  - **Scopes:** content is global or per store; a store's item with the same slug, identifier or code wins in that store.
  - **Author:** posts record the admin author, but the storefront doesn't expose admin identities.

**Phase 5 — done (2026-10-04).**

- **Done criterion met:** `test/customers-marketing-loyalty.e2e-spec.ts` (real API + workers) checks:
  - a campaign scheduled 2 s ahead: its published promotions and coupon don't apply before it starts (`INACTIVE`), apply exactly from its start (20% off tees, then $5 + free shipping with the coupon, spread over the lines), and stop when it ends;
  - coupon limits under concurrency: 8 simultaneous orders against a 3-use coupon → exactly 3 recorded, 5 refused (409); idempotent per order; releasing a cancelled order gives the use back; 250 codes generated in bulk by the worker;
  - points: earned once per order with the tier multiplier (Gold ×1.5 after crossing 500 points), redeemed within the minimum and the 50% cap, a cancelled order's redeemed points returned to their original credits, a partial refund reversing ⅓ of the earned points and the rest never more than earned, tiers dropping when points are reversed, and expiry FIFO after 365 days;
  - storefront accounts: sign-up, per-website sign-in, refresh rotation with reuse detection, address book defaults, group prices for signed-in shoppers (`private, no-store`), disabling and password changes ending sessions.
- **Schema:** migration `0007_customers_marketing_loyalty` adds 14 tables (141 FKs pinned in the migration test), CHECKs (usage counters within limits, coupon code format, ledger signs and `remaining ≤ points`, non-negative balances), case-insensitive e-mails per website and coupon codes, one default address of each kind, and earn/redeem once per order (partial unique index).
- **Modules:**
  - `customers`: accounts, addresses, storefront sessions (customer JWT, audience `shop-customer`, rotating refresh tokens), admin CRUD;
  - `marketing`: campaigns, cart promotions (typed rules validated on save), coupons with bulk generation, a pure promotion engine, and redemption with conditional UPDATEs for limits;
  - `loyalty`: programs per website, tiers, and a ledger with FIFO allocations.
  - Campaigns and promotions use the Phase 4 publishing model and scheduler.
- **Storefront:** `account/*` (register, login, refresh, logout, password, profile, addresses, loyalty), additive (the breaking-change guard passed). Catalog routes accept an optional customer token for group prices; the store scope resolves it through an injected resolver, so `stores` doesn't depend on `customers`. The client gained an `accessToken` option and account types.
- **Tests:** 473 unit (97.8% lines, 89.7% branches) and 119 e2e across 8 suites. Verified live in containers: seed (welcome campaign with WELCOME10, tee deal, loyalty programs with tiers) → sign-up → group price private → cart evaluation and redemption → second use refused for the same customer → earn, redeem, refund → shopper's loyalty summary → 500 coupons generated by the worker → logout; no outbox backlog.
- **Found and fixed:**
  - Class-level `@Header` crashes Nest's decorator; account routes set `no-store` with an interceptor instead.
  - The coupon worker couldn't start: `CouponsService` wasn't exported for the worker's processor.
  - A coupon blocked by the customer's own limit said "used up"; it now says `ALREADY_USED` ("You have already used this offer").
- **Decisions:**
  - **Accounts per website** (Magento "per website" sharing); a token only works on its website's stores.
  - **Catalog sales stay price books** (with validity windows, Phase 2); promotions are cart rules. There is no separate "catalog promotion" type.
  - **Evaluation is server-side:** `redeem` re-evaluates the cart; client-sent discounts are never trusted. Per-customer limits apply to signed-in customers; guest limits by e-mail come with checkout.
  - **Time-based activation** like content: a campaign's window gates its promotions and coupons exactly; the scheduler records start and end.
  - **Points ledger:** balance = Σ remaining on credits; debits record which credits they consumed, so cancellations return points to the same credits (and expiry dates). Refunds never take the balance below zero; the note records any shortfall.
  - **Order integration:** checkout (Phase 6) calls redemption and the ledger on order placed, paid, cancelled and refunded; until then the admin endpoints serve integrations.
  - **Deferred:** password reset and expiry-reminder e-mails need the notifications module (Phase 6/7); banners are not linked to campaigns (they keep their own schedule).

**Phase 6 — done (2026-10-04).**

- **Done criterion met:** `test/checkout.e2e-spec.ts` runs the real API and workers against a payment emulator that speaks each provider's sandbox protocol and verifies our keys and signatures (no request was ever rejected). Each provider goes cart → order → payment → shipment → refund:
  - **Stripe** (guest, USD): one order per `Idempotency-Key` (a retry returns it), client secret, a signed webhook applied once (a replay is a duplicate), invoice, shipment, then a refund of one returned tee (restocked) and of the rest (order closed);
  - **PayPal** (signed-in customer whose guest cart merged on sign-in): a return before approval fails and a new attempt is captured on return; points are earned on payment. The refund is answered as pending: nothing changes and nothing more can be refunded until reconciliation finds it completed, then the order is refunded, gets a credit memo and loses the points;
  - **VNPay** and **MoMo** (VND, tax-inclusive store): signed redirect, signed IPN answered in the provider's format, refund through the merchant API;
  - **COD:** accepted at once, stock sold, shipped, then cash collected → complete;
  - **Cancellations:** a cancelled unpaid order gives back stock and promotion uses; unpaid orders expire after 60 minutes, and a payment arriving after that is refunded automatically.
- **Schema:** migration `20261114000100_checkout` adds 20 tables (FKs now 178, all pinned in the migration test). CHECKs keep the money consistent (amount due = grand total − points; refunded ≤ paid; refunds and credit memos positive; quantities within bounds). Unique indexes: one order per store and `Idempotency-Key` and per cart; one open payment per order (partial index); each provider event recorded once; one invoice per order and one credit memo per refund. Document numbers come from gap-free sequences per website.
- **Modules:**
  - `shipping`: methods per website (flat or per item, per currency, free-over thresholds, countries, tax class).
  - `carts`: guest token or customer session, merge on sign-in. A pricer prices the cart exactly as checkout charges it (tier prices, bundles, stock, promotions, shipping, destination tax, points as a tender after tax) and lists what is still `missing`.
  - `orders`: the placement saga, lifecycle, shipments, invoices, credit memos, history; listeners for stock, cart, points and promotion effects.
  - `payments`: provider registry (Stripe, PayPal, VNPay, MoMo, COD) with sealed credentials, store methods, payments, webhooks, refunds, reconciliation, and the `jobs` processor (expire unpaid, reconcile, purge carts).
  - Other modules gained only read or idempotent entry points: inventory `reserve` with a caller-chosen group and `returnStock`; marketing `evaluateLines` and `redeemEvaluation`; loyalty `redemptionTerms`; products `cartLines`; customers `address`.
- **Storefront:** `cart/*`, `orders`, `orders/:number/payments`, `cart/payment-methods`; additive to v1. The client gained checkout types and a `cartToken` option.
- **Tests:** 577 unit (98% lines, 90.7% branches); 134 e2e across 9 suites. `npm audit`: 0 vulnerabilities. Verified live in containers: seed (shipping methods, cash on delivery) → guest cart with WELCOME10 and free shipping → order (a retry returned it) → COD → shipment → cash collected → COMPLETE with invoice → partial refund with restock → credit memo; stock movements SALE ×2 and RETURN ×1; outbox empty, no errors logged.
- **Found and fixed:**
  - A late payment on a cancelled order wasn't refunded: the refundable amount came from the order's `amountPaid`, which is updated asynchronously. It now comes from the captured payments, and the refund event carries the captured total.
  - Refunds the provider answers as pending (Stripe, PayPal, MoMo) stayed pending forever. Reconciliation now asks about them, and the outcome is recorded once (conditional update).
  - Switching a provider to LIVE without new credentials skipped the https check on stored endpoint overrides.
  - The admin refund endpoint returned the order's latest refund rather than the one it made.
  - The order-payment routes declared `X-Order-Token` as required, and cart payment methods declared it at all (a one-time correction to these new, unreleased routes).
  - Carts read customer addresses from the customers table; this now goes through `CustomersQuery`.
  - Empty carts reported a missing billing address; `orders.id` lacked its UUID default (caught by the migration test).
- **Decisions:**
  - **Prices are never stored on carts:** every cart response is re-priced, and placement prices it once more inside the saga, so the order total is what the shopper saw.
  - **Saga, not a distributed transaction:** each step is idempotent per order id, which is derived from the cart and the `Idempotency-Key`. A failure compensates the earlier steps, a retry resumes, and a Redis lock serialises the same key.
  - **Guest access** is an HMAC-derived order token; only its hash is stored, and a retry hands out the same token.
  - **Points are a tender**, applied after tax (like a gift card); points are earned on the goods' net value when the order is paid.
  - **Money first, questions later:** unwanted money (a cancelled order, or paid twice) is refunded automatically; a mismatched amount is never captured and is logged for staff.
  - **COD** is accepted at placement (`PROCESSING`) and becomes paid when staff record the cash; orders complete when they are both paid and fulfilled.
  - **Deferred to Phase 7:** order e-mails (notifications module), settlement-report reconciliation (the job uses status queries), Adyen and bank transfer, guest per-e-mail promotion limits.

**Phase 7 — done (2026-10-05).**

- **Done criterion met:**
  - **SLOs** (docs/RUNBOOK.md#slos) checked with k6 (`loadtest/storefront.js`) against the containerised stack (one API and one worker container, production mode, on a laptop): 60 storefront reads/s plus 2 guest checkouts/s with cash on delivery (≈ 76 req/s, 3 minutes). Reads p95 138 ms (SLO 300 ms), search p95 122 ms (400 ms), cart and checkout writes p95 428 ms (1 s), placing an order p95 831 ms (1.5 s), 0 failed requests.
  - **Dashboards and alerts live:** `docker compose --profile monitoring` runs Prometheus (API and worker scraped, 25 rules), Alertmanager and Grafana ("Shop overview", 27 panels). Stopping the worker fired `ShopWorkerDown`, which was e-mailed to Mailpit about 3 minutes later, followed by its "resolved" notice. During a stress run `StorefrontLatencyHigh` fired and resolved. The rules have promtool unit tests (`npm run ops:check`).
- **Load testing found and fixed:** the first run saturated at ~63 req/s (reads p95 6.8 s). Profiling showed the API idle and Postgres busy: a product page costs ~45 queries. Product pages and cards are now split into a catalog part cached in Redis (purged on every catalog change) and prices and stock read per request. The cache hit ratio is 99.3%, and pages stay exact for stock and prices. Two intermediate designs were rejected along the way: whole-response caching purged per product broke exact stock and publishing windows (e2e), and stock purges collapsed the hit ratio under checkout load (26%). Capacity: with an intermediate cache design, one API container saturated at about 180 req/s once 5 checkouts/s were added (not re-measured with the final design). Checkout requests are the expensive ones (each cart step is priced in full), so checkout-heavy traffic needs more API replicas.
- **Schema:** migration `20261121000100_ops` adds `jobs`, `job_executions` (at most one open run per job, partial unique index; finished runs carry their end time), `webhooks` and `webhook_deliveries` (once per webhook and event), and `audit_logs.event_id` (each event audited once). FKs: 182.
- **Modules and features:**
  - **Jobs** (`jobs`): a registry of job types discovered from `@JobHandler()` providers in their own modules, so the jobs module depends on none of them. Definitions have parameters, a cron expression and a time zone, synced to BullMQ schedulers. Executions record status, progress, counters, the first 100 row errors and output files. Supported: cancellation; recovery when a worker dies (lost messages re-queued, abandoned runs failed); file retention (7 days) and history retention (90 days). Running a type needs `jobs:write` plus that type's own permission.
  - **Exports** (CSV, UTF-8 with BOM, spreadsheet formulas neutralised; short-lived download links): products, prices, stock, customers, orders, audit log. **Imports** (multipart upload): products, prices and stock, through the owning modules' services (validated, audited, evented), per-row errors, safe to repeat. **Maintenance types:** search reindex, price index rebuild, URL rewrite rebuild.
  - **Outgoing webhooks:** an event catalogue (orders, payments, products, stock, customers, job executions) with payloads that are ids and amounts only. Deliveries are signed (`X-Shop-Signature`, HMAC-SHA256 of `t.body`) with deterministic ids (once per event), retried with exponential backoff (10 attempts, ≈ 8.5 h), and switched off after 20 failures in a row or on 410 Gone. Also: redelivery and test pings. SSRF protection checks addresses when saving and again at connect time (DNS rebinding, IP literals, Happy Eyeballs lookups).
  - **Audit:** written once per event (stable outbox event ids); retention purge (`AUDIT_RETENTION_DAYS`); export job.
  - **Metrics:** prom-client, labelled by role. HTTP latency by route template (unmatched paths share one label); job durations for every queue; business counters (orders, payments, payment notifications, failed sign-ins, executions, webhook deliveries, outbox failures); scrape-time backlog gauges (queues, outbox, executions, webhooks, stale payments, pending refunds). The API serves `/api/v1/metrics` and each worker `:9464/metrics` and `/health`, behind `METRICS_TOKEN` (required in production).
  - **Ops config:** bounded DB pool (`DATABASE_POOL_MAX`, `DATABASE_POOL_TIMEOUT_MS`), `S3_PUBLIC_ENDPOINT` for signed links when storage is internal, `STOREFRONT_CACHE_TTL_S`. Checkout housekeeping moved to its own `checkout` queue (the `jobs` queue runs admin jobs; old schedulers are removed at worker start).
- **Tests:** 660 unit (98.2% lines, 90.7% branches) and 144 e2e across 10 suites. The new `ops.e2e-spec.ts` covers a cron definition reaching BullMQ, run now, an export downloaded from MinIO, price and stock imports with row errors and idempotence, signed webhooks to a live receiver (410 switches the webhook off, redelivery after re-enabling), the audit log written once, and metrics behind the token. The migration test has 34 cases. `npm audit`: 0 vulnerabilities. Live: everything above, plus the seeded nightly orders export scheduled, a stock export downloaded in the browser, an edited re-import of 16 rows, and executions visible in Prometheus.
- **Found and fixed:**
  - Signed links pointed at the internal `minio:9000`; `S3_PUBLIC_ENDPOINT` fixes it.
  - BullMQ refuses job ids containing `:`, so webhook redelivery returned 500.
  - The SSRF lookup broke Node's `all: true` connects, and IP-literal URLs skipped the lookup entirely.
  - The first progress update and cancellation check of an execution could be throttled away.
  - Metrics label for 404s fell back to the middleware's `*path` route.
  - Meilisearch index creation wasn't safe to retry (`index_already_exists` failed a switch; a Phase 3 latent bug seen under load).
  - An unbounded DB pool wait meant overload hung requests instead of failing them.
  - A time-dependent flake in a Phase 6 unit test.
- **Decisions:**
  - **Job types live in their modules** (exports read their own tables, imports call their own services); the jobs module only discovers and runs them.
  - **Imports are row-by-row through the domain services:** slower than bulk SQL, but validation, events, audit and indexing behave exactly as in the admin. Files up to `IMPORT_MAX_MB` (50) and 200,000 rows.
  - **Webhooks are at least once:** receivers de-duplicate on `X-Shop-Event-Id`. Payloads carry ids and amounts, never actor identities or changed values.
  - **Cache what is expensive and stable, compute what changes per order:** prices and stock are always live. Search and CMS responses are not cached by the API (stock filters and publishing windows change without events); a CDN can still cache them per `Cache-Control`.
  - **Metrics:** counters are per process (`sum`); backlog gauges come from the API (`max`).
  - **Deferred (feature expansion, §13):** order and account e-mails (notifications module); bulk SQL imports for very large catalogs; per-tenant alert routing; partitioning of `audit_logs` and `webhook_deliveries` once large (§12).

## 15. Decisions (resolved 2026-10-03)

| #   | Question      | Decision                                                                      | Where       |
| --- | ------------- | ----------------------------------------------------------------------------- | ----------- |
| 1   | Multi-store   | Many websites/stores sharing one catalog                                      | §0.11, §3.3 |
| 2   | Payments      | Multiple providers, configurable per store                                    | §0.12, §9.6 |
| 3   | Search        | Postgres full-text first; Elasticsearch / OpenSearch / Meilisearch selectable | §0.13, §9.5 |
| 4   | Frontend      | Yes: storefront API is contract-first from Phase 1                            | §0.14, §7.1 |
| 5   | Product types | Configurable and bundle (plus simple, virtual, gift card) at launch           | §0.15, §3.2 |
| 6   | Tax           | Multi-country; prices tax-inclusive per store where required                  | §0.16, §9.7 |
| 7   | Loyalty       | Points per currency unit, expiry and tiers, all configurable per website      | §0.17, §9.8 |
| 8   | Media         | S3 / MinIO                                                                    | §0.18       |

**Still worth confirming** (the plan proceeds on these defaults):

- Payment providers: Stripe, PayPal, VNPay, MoMo and COD are built and pass against sandbox-protocol emulators (Phase 6). Run each once against its real sandbox with real test keys before launch.
- Launch countries for the tax fixtures: VN, US, and one EU country.
