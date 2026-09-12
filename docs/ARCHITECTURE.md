# SnapPOS Platform Architecture

Working codename: `snappos`. Rename before commercialization; the name appears only in package identifiers, the Android application ID and the database role names, all of which are listed in `docs/RENAME.md` when you decide.

Status: architecture approved for build. Phase 1 database schema is written and executed. Application scaffolds follow.

Author's note on scope: the full brief describes roughly 9 to 15 months of work for two or three experienced engineers. This document is the plan that makes that work survivable, and it is deliberately opinionated about what ships first. Section N defines the MVP. Section M is the honest risk list, and three of those risks are not engineering problems at all.

---

## A. SYSTEM ARCHITECTURE

### Component map

```
                          ┌───────────────────────────────────┐
                          │         CUSTOMERS / PUBLIC        │
                          │  storefront (Next.js PWA)         │
                          └────────────────┬──────────────────┘
                                           │ HTTPS
┌──────────────────────┐                   │                 ┌────────────────────┐
│  ANDROID POS         │                   │                 │  ADMIN DASHBOARD   │
│  Kotlin / Compose    │                   │                 │  Next.js / React   │
│                      │                   │                 │                    │
│  Room + SQLCipher    │                   │                 │  server components │
│  local outbox        │                   │                 │  + REST            │
│  local price engine  │                   │                 └─────────┬──────────┘
│  hardware adapters   │                   │                           │
└──────┬───────┬───────┘                   │                           │
       │       │ FCM push                  │                           │
  REST │       └───────────────┐           │                           │
  +WS  │                       ▼           ▼                           ▼
       │              ┌──────────────────────────────────────────────────────┐
       └─────────────▶│              API GATEWAY (NestJS / Fastify)          │
                      │  auth · RBAC · validation · rate limit · idempotency │
                      └───┬──────────────┬───────────────┬──────────────┬────┘
                          │              │               │              │
                 ┌────────▼───┐  ┌───────▼──────┐ ┌──────▼──────┐ ┌─────▼──────┐
                 │  DOMAIN    │  │   SYNC       │ │  COMPLIANCE │ │  PROVIDER  │
                 │  SERVICES  │  │   SERVICE    │ │   ENGINE    │ │  ADAPTERS  │
                 │            │  │              │ │             │ │            │
                 │ catalog    │  │ change_log   │ │ rule eval   │ │ Payment    │
                 │ inventory  │  │ outbox intake│ │ jurisdiction│ │ Delivery   │
                 │ sales      │  │ idempotency  │ │ age gates   │ │ SMS/Email  │
                 │ pricing    │  │ reconcile    │ │ fail-closed │ │ Tax / EDI  │
                 │ customers  │  │              │ │             │ │ AgeVerify  │
                 └─────┬──────┘  └──────┬───────┘ └──────┬──────┘ └─────┬──────┘
                       │                │                │              │
                       └────────────────┴────────┬───────┴──────────────┘
                                                 │
                    ┌────────────────────────────┼─────────────────────────┐
                    │                            │                         │
            ┌───────▼────────┐         ┌─────────▼────────┐       ┌────────▼───────┐
            │  PostgreSQL    │         │  Redis           │       │  S3 / R2       │
            │  source of     │         │  cache · pub/sub │       │  images        │
            │  truth         │         │  BullMQ queues   │       │  documents     │
            │  ledgers       │         └─────────┬────────┘       │  exports       │
            │  change_log    │                   │                └────────────────┘
            └────────────────┘         ┌─────────▼────────┐
                                       │  WORKER FLEET    │
                                       │  forecasting     │
                                       │  marketing       │
                                       │  EDI · webhooks  │
                                       │  reports · sweep │
                                       └──────────────────┘
```

### How components communicate

1. **Register to backend**: REST over HTTPS for all writes, with an `Idempotency-Key` header on every financial operation. A WebSocket channel carries live events while the app is in the foreground. Firebase Cloud Messaging wakes the app for online orders when it is backgrounded or the socket has dropped. The register never depends on the socket for correctness; the socket is a latency optimization over polling.
2. **Backend to backend**: domain services emit events onto a Postgres outbox table inside the same transaction as the business write. A relay worker moves those events to Redis streams. This is the transactional outbox pattern and it is the only way to guarantee that "sale committed" and "sale event published" cannot diverge.
3. **Storefront and dashboard to backend**: REST, generated from the same OpenAPI document that produces the Android client. Next.js server components call the API over the internal network with a service token.
4. **Providers**: every third party sits behind an interface in `apps/api/src/providers/*`. Core code depends on the interface only. Each provider ships a real adapter, a sandbox adapter and a deterministic mock adapter used in tests.

### Why an API gateway rather than direct database access

The register is an untrusted client sitting on a shop counter, sometimes on a device an employee can walk out with. Pricing, promotion selection, inventory decrement, refund authorization and compliance decisions are all server-authoritative facts. The register computes them locally so it can work offline, but the server recomputes and records its own result on intake. When the two disagree the sale still stands (the customer already left) and the difference is written to a variance report. That is the only safe shape for this system.

This is also why Supabase Auth plus row level security as a primary authorization model is the wrong fit here, even though Supabase is a fine managed Postgres host. That model puts authorization in the database and lets clients talk to it directly. We need a server tier regardless for the offline intake, idempotency, provider calls and the compliance engine.

---

## B. FINAL TECHNOLOGY STACK

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Backend framework | **NestJS on Fastify, TypeScript 5.x** | See below. |
| Database | **PostgreSQL 16+**, managed (Neon, RDS or Supabase Postgres) | Nothing else gives you partial indexes, exclusion constraints, `jsonb` rule storage, range partitioning and real transactional integrity in one box. |
| DB access | **Drizzle ORM** for queries, **hand written SQL** for migrations | Drizzle gives compile time types without hiding SQL. Migrations stay hand written because this schema uses CHECK constraints, partial unique indexes, partitioning, domains and RLS that ORM migration generators routinely mangle. |
| Cache, queues, pub/sub | **Redis 7** + **BullMQ** | Mature, one dependency, good observability. |
| Object storage | **Cloudflare R2** (S3 API) | Same API as S3 with no egress fees, which matters when the storefront serves product images. Swap to S3 by changing an endpoint. |
| Realtime | **Nest WebSocket gateway over Redis pub/sub**, **FCM** for push | FCM is the only thing that reliably wakes a backgrounded Android app on a shop wifi network. |
| Search (server) | **Postgres `pg_trgm` + `tsvector`** now, Typesense later | A single store has thousands of SKUs, not millions. A GIN trigram index answers fuzzy SKU search in under 5ms. Adding a search cluster on day one is cost and operational burden with no payoff. |
| Search (register) | **SQLite FTS5 + trigram scoring, on device** | Register search must work offline and must respond in under 30ms. It is never a network call. |
| Android | **Kotlin, Jetpack Compose, Room + SQLCipher, Hilt, WorkManager, Retrofit + OkHttp + kotlinx.serialization, DataStore** | Retrofit over Ktor client purely for interceptor and certificate pinning maturity on Android. |
| Web apps | **Next.js 15 App Router, React 19, TypeScript, Tailwind v4, Radix primitives + custom component layer** | Radix gives accessible behavior; the visual layer is ours (see Section O). Not shadcn as shipped, because the default shadcn look is exactly the generic dashboard the brief says to avoid. Use it as a starting point and replace the tokens. |
| Auth | **Self hosted**, Argon2id, short lived JWT access tokens, rotating refresh tokens | Payment, compliance and audit requirements make outsourcing identity more trouble than it saves. |
| Observability | **OpenTelemetry** → Grafana Cloud or Better Stack, **Sentry** for errors | |
| CI/CD | **GitHub Actions**, Docker images to GHCR, deploy to **AWS ECS Fargate** or **Fly.io** | Fly.io for the first year (cheaper, simpler). ECS when multi region or compliance audits demand it. |
| Secrets | **AWS Secrets Manager** or **Doppler**, never in the repo | |

### The backend decision, with the tradeoff stated plainly

**NestJS + TypeScript wins, but the case for Kotlin + Ktor is stronger than it first looks.**

Kotlin's real advantage is not throughput. It is that the pricing, promotion and tax engine has to run twice: once on the Android register so a cashier can ring a sale with no internet, and once on the server so the server can verify it. Two implementations of the same rules in two languages will drift, and drift in a pricing engine means the customer was charged something the reports disagree with. Kotlin Multiplatform could make that one implementation.

I am still choosing TypeScript, for three reasons. Two of the four applications are Next.js, so a shared TypeScript contracts package removes far more duplication than KMP would add. The integration surface in this brief is enormous (payment gateways, Twilio, delivery APIs, EDI, tax, S3, FCM) and the Node SDK ecosystem for those is materially better maintained. And KMP tooling would sit on the critical path of every backend change, which is a real tax paid every day for a benefit collected in one module.

**The mitigation for the duplicated engine is not optional, it is a hard requirement.** `packages/pricing-spec/` holds a growing language-neutral conformance suite. Its first 51 cases pin the shared money primitives down to the cent; cart, promotion, rule-set and timestamp fixtures expand it as those engines arrive. The TypeScript engine and the Kotlin engine both run the same JSON in CI. A rule change is not merged until both pass. Every pricing bug found in production becomes a new fixture. This is the mechanism that keeps two implementations honest, and it is cheap to maintain.

### Money representation

Posted financial amounts are `bigint` minor units (cents), named with a `_minor` suffix everywhere, never floats. Catalog cost fields are `numeric(14,6)` because a case of 12 at $5.00 is a unit cost of $0.416667 and truncating that to cents corrupts margin reporting within weeks. Rounding happens once per line at the moment the line is posted, half up, and the rounded value is what is stored. This is written down in `docs/MONEY.md` and enforced by a shared `Money` type that has no implicit conversion to `number`.

---

## C. REPOSITORY STRUCTURE

Single monorepo, npm workspaces for the TypeScript side, Gradle for Android. (Revised from pnpm plus Turborepo: npm ships with Node, supports workspaces fully, and removes an install step before a new machine can build. Turborepo can be added later if build caching starts to pay for itself.) One repository because the contracts package, the pricing spec and the migrations are shared by everything, and splitting them means version skew between the register and the API.

```
snappos/
├── apps/
│   ├── api/                    NestJS. The only thing that talks to Postgres.
│   │   └── src/
│   │       ├── modules/        catalog, inventory, sales, cash, customers,
│   │       │                   loyalty, promotions, purchasing, compliance,
│   │       │                   sync, reporting, marketing, admin
│   │       ├── providers/      PaymentProvider, DeliveryProvider, SmsProvider,
│   │       │                   EmailProvider, TaxProvider, AgeVerificationProvider,
│   │       │                   EdiProvider  (interface + adapters/ + mock/)
│   │       ├── platform/       auth, rbac, audit, idempotency, outbox,
│   │       │                   feature-flags, tenancy, errors, telemetry
│   │       └── main.ts
│   ├── dashboard/              Next.js admin
│   ├── storefront/             Next.js customer site (PWA)
│   └── pos-android/            Gradle multi module
│       ├── app/                Compose UI, navigation, DI wiring
│       ├── core-domain/        pure Kotlin. No Android imports. Testable on JVM.
│       ├── core-data/          Room entities, DAOs, repositories, outbox
│       ├── core-sync/          WorkManager jobs, conflict handling, change cursor
│       ├── pricing-engine/     Kotlin implementation of the pricing spec
│       ├── hardware/           HardwareManager + per vendor adapter modules
│       │   ├── hardware-api/   interfaces only
│       │   ├── hw-escpos/      hw-sunmi/  hw-pax/  hw-hid/  hw-bluetooth/
│       └── feature-*/          register, cart, payment, cashdrawer, counts,
│                               orders, settings
├── packages/
│   ├── db/                     migrations/*.sql, drizzle schema, seed data
│   ├── contracts/              Zod schemas → TS types → OpenAPI → Kotlin client
│   ├── pricing-engine/         TypeScript implementation of the pricing spec
│   ├── pricing-spec/           fixtures/*.json  ← the conformance suite
│   ├── ui/                     shared React component layer + design tokens
│   └── config/                 eslint, tsconfig, tailwind presets
├── services/
│   └── worker/                 BullMQ processors. Same codebase as api, separate deploy.
├── infra/
│   ├── docker/                 Dockerfiles, docker-compose.dev.yml
│   └── terraform/              environments: dev, staging, prod
├── docs/                       ARCHITECTURE, DATABASE, API, ANDROID, HARDWARE,
│                               SECURITY, COMPLIANCE, DEPLOYMENT, TESTING,
│                               INTEGRATIONS, MONEY, CHANGELOG
└── .github/workflows/
```

Rule enforced in CI: `core-domain` and `pricing-engine` on Android may not import anything from `android.*`. They run as plain JVM unit tests, which is what makes the pricing conformance suite fast enough to run on every commit.

---

## D. DATABASE DESIGN

Full DDL is in `packages/db/migrations/`. It has been executed against Postgres and it runs clean. Column level detail lives in `docs/DATABASE.md`. What follows is the reasoning.

### Six rules the schema obeys

1. **Every tenant table carries `org_id`**, and child tables use composite foreign keys `(id, org_id)` so a row physically cannot reference a parent in another organization. Row level security is enabled on top of that as defense in depth. The application connects as `snappos_app`, which is not a superuser and does not have `BYPASSRLS`.
2. **Primary keys are UUIDv7**, generated by `uuid_generate_v7()`. Time ordered, so index locality is good, unlike v4. Critically, the register can generate them offline and the server accepts them as given.
3. **Financial and inventory history is append only.** Sales, payments, refunds and inventory movements are never updated in place. A void is a new record. A correction is a new record. `inventory_levels` is a fast projection; `inventory_ledger` is the truth, and a nightly job proves the projection still equals the sum of the ledger.
4. **Everything sellable is a variant.** A product with no flavors still has exactly one variant row. This removes an enormous amount of branching in pricing, inventory, barcodes and reporting. Barcodes, cost, price and stock live on the variant, never on the product.
5. **Compliance rules are data with effective dates, never code.** Section I explains why this is non negotiable for this particular business.
6. **High volume history is partitioned monthly from day one** (`inventory_ledger`, `audit_log`). Retrofitting partitioning onto a live 60 million row audit table is a weekend nobody enjoys.

### Core entity relationships

```
organizations
  └─ stores ──┬─ registers ── devices
              ├─ store_hours, delivery_zones
              ├─ inventory_levels ─────────┐
              ├─ variant_prices            │
              └─ tax_rates                 │
                                           │
users ─ user_org_roles ─ roles ─ role_permissions
  └─ employee_pins (Argon2id, offline verifiable)

brands        categories (materialized path, unlimited depth)
   └───────────────┬──────────────┘
                   ▼
              products ── product_variants ──┬─ variant_barcodes  (many: UPC, alt UPC, PLU)
                             │               ├─ variant_prices    (per store, effective dated)
                             │               ├─ variant_attributes (flavor, size, strength, color)
                             │               ├─ product_compliance (min age, channel flags)
                             │               └─ vendor_variants   (vendor SKU, case qty, cost)
                             │
                             ├──────────────▶ inventory_levels (store, on_hand, reserved)
                             ├──────────────▶ inventory_ledger (append only, partitioned)
                             ├──────────────▶ inventory_reservations (TTL)
                             └──────────────▶ cost_layers (receipt lots, enables FIFO later)

vendors ── purchase_orders ── purchase_order_lines ── po_receipt_lines

cash_sessions ── cash_movements
     │
     └── sales ──┬─ sale_lines ── sale_line_discounts
                 ├─ payments  ── payment_events
                 ├─ refunds   ── refund_lines
                 └─ age_verifications (metadata only, no ID images)

customers ──┬─ customer_consents (SMS, email, timestamped, source recorded)
            ├─ loyalty_accounts ── loyalty_transactions
            ├─ store_credit_ledger
            └─ orders (online) ── order_lines ── delivery_jobs ── delivery_events

audit_log (partitioned, hash chained)   change_log (sync cursor)
outbox_events                           idempotency_keys
```

### Tables that deserve specific comment

**`inventory_ledger`** carries `delta`, `reason`, `reference_type`, `reference_id`, `actor_user_id`, `occurred_at`, `unit_cost` and `org_id`. There is no code path anywhere in the system that changes stock without writing one of these. The reason column is a Postgres enum, so an unlisted reason is a migration, not an accident.

**`change_log`** is the backbone of downstream sync. Every server side write to a register replicated table appends `(org_id, store_id, entity_type, entity_id, op, payload_hash)` with a `bigserial` cursor, inside the same transaction as the write itself.

**`idempotency_keys`** stores `(org_id, key, request_hash, response_status, response_body, expires_at)` with a unique index on `(org_id, key)`. A replayed request with a matching hash returns the stored response. A replayed request with a different hash is a 409, which catches genuine client bugs instead of silently corrupting data.

**`audit_log`** is partitioned by month and hash chained per organization: each row stores `prev_hash` and `hash`. The chain is sealed asynchronously by a single serialized worker rather than a trigger, because triggers cannot order concurrent inserts without taking a lock that would slow down checkout. A broken chain means someone edited history in the database directly, which is exactly what a loss prevention system needs to be able to prove.

---

## E. OFFLINE SYNC DESIGN

This is the part of the system that decides whether the shop trusts the software. The design goal is absolute: **a completed sale is never lost and never duplicated, and the register never blocks on the network.**

### What lives on the register

Room, encrypted with SQLCipher using a key held in the Android Keystore: the full variant catalog for that store, barcodes, prices and effective dated price changes, promotion rules, tax rules, compliance rules, an inventory snapshot, employee permission sets and PIN hashes, register configuration, and held or parked transactions. Customers are pulled on demand and cached by phone number, because caching the full customer table on a device that can be stolen is a privacy problem with no operational payoff.

### Writing a sale

```
cashier taps PAY
   │
   ├─ generate sale_id = UUIDv7  (on device, never server assigned)
   ├─ receipt_no = "{store_code}-{register_code}-{local_seq}"   ← printable with no network
   ├─ price + promo + tax computed by the local Kotlin engine
   ├─ payment captured by the terminal (see Section K) → returns token + approval
   │
   └─ ONE local SQLite transaction:
        INSERT sale, sale_lines, payments
        INSERT inventory_ledger_local (negative deltas)
        UPDATE local inventory projection
        INSERT sync_outbox (entity='sale', id=sale_id, payload, attempts=0)
      COMMIT
   │
   └─ receipt prints. Cashier is done. Elapsed network time: zero.
```

The receipt number is composite rather than a global sequence precisely so it can be produced offline without a number server. Stores that require strictly sequential receipt numbering get a **lease block** instead: the server hands the register a range of 1000 numbers in advance, and the register requests a new block at 20 percent remaining. Both modes are supported; composite is the default.

### Uploading

A WorkManager job with exponential backoff drains `sync_outbox` in batches of 50, oldest first, over a single HTTP request per batch. Each entity carries its own `Idempotency-Key` equal to its UUIDv7. Server intake is:

```sql
INSERT INTO sales (id, org_id, ...) VALUES (...)
ON CONFLICT (id, org_id) DO NOTHING
RETURNING id;
```

Zero rows returned means it already existed, which means this is a duplicate delivery, which is a success. The server returns its canonical view of each entity and the register marks the outbox row `acknowledged`. **Duplicate submission is structurally impossible to turn into a duplicate sale**, and that property does not depend on the network behaving, on retries being polite, or on anyone remembering to write a deduplication check.

Batches are ordered but not atomic: entity 7 failing does not block entities 1 through 6. Anything that fails validation five times is moved to `sync_dead_letter` and raises a Sync Error on the register, which is a state a manager can see and a support engineer can inspect, rather than a silent hole in the day's numbers.

### Downloading

Registers poll `GET /v1/sync/catalog?store_id={store}&since={cursor}`. The server
uses `change_log` to select affected register projections, reads those
projections, and returns their cursor in one transaction. A price-only change
therefore returns prices only; an empty `included_scopes` transfers no catalog
rows. The separate `/sync/changes` notification endpoint remains available for
integrations and diagnostics, but the register does not split detection from
fetching because doing so introduces a cross-scope cursor race. The cursor is
the `bigserial` id from `change_log`, not a timestamp. Timestamps are wrong here
for two reasons: device clocks drift, and two transactions committing at the
same instant are not distinguishable.

There is one subtlety that most implementations get wrong. A `bigserial` value is allocated before the transaction commits, so a row with id 500 can become visible after a row with id 501. A naive reader that consumes up to `max(id)` will permanently skip row 500. The fix is to only consume rows below the transaction watermark:

```sql
SELECT * FROM change_log
WHERE org_id = $1 AND id > $2
  AND id < (SELECT COALESCE(min(c.id), 9223372036854775807)
            FROM change_log c
            WHERE c.xmin::text::bigint >= pg_snapshot_xmin(pg_current_snapshot())::text::bigint)
ORDER BY id LIMIT 500;
```

In practice this is wrapped in a helper function in `packages/db`. The point is that the gap problem is handled once, in one place, with a test that specifically forces interleaved commits.

### Conflicts, and why most of them are not conflicts

| Situation | Resolution |
|---|---|
| Two registers sell the last unit while both are offline | Both sales are accepted. The ledger applies both deltas and on hand goes to -1. This raises a `NegativeInventory` alert with both sale ids attached. **A completed sale is never rejected.** The customer already left with the product; refusing the record does not un-sell it, it only hides the problem. |
| Catalog edited in the dashboard while a register is offline | Server wins on catalog. The register overwrites its local copy on next sync. |
| Price changed centrally after an offline sale rang the old price | The sale keeps the price actually charged. `sale_lines` stores the price, the cost and the promotion ids as they were at the moment of sale. A variance report shows the difference. Reprice history never rewrites a sale. |
| Same physical sale uploaded twice | No-op, by the idempotency design above. |
| Offline card payment | Not permitted by default. Card capture requires the terminal, and the terminal requires its own connectivity. Terminals that support store and forward with a floor limit can be enabled per store, and that is a risk decision the owner makes explicitly in settings, not a default. Offline means cash by default. |
| Device clock wrong | Every upload carries `device_time` and the server records `received_at`. A clock offset is measured at handshake and stored on the device record. Reports use server time. |

### Sync state shown to the cashier

A single pill in the register header, always visible: `Online` (green), `Syncing n` (blue, with count), `Offline` (amber, with "sales are being saved on this device"), `Sync Error` (red, tappable, opens the dead letter list). Amber is deliberately not red. Offline is a normal, safe operating mode and the interface should not communicate panic about it.

---

## F. INVENTORY DESIGN

### The ledger is the truth, the level is a cache

```
inventory_ledger (append only, monthly partitions)
   id, org_id, store_id, variant_id, delta, reason, unit_cost,
   reference_type, reference_id, actor_user_id, occurred_at

inventory_levels (one row per store × variant, updated in the SAME transaction)
   on_hand, reserved, available GENERATED AS (on_hand - reserved)
```

Both writes happen in one transaction, always, through one repository method that is the only code permitted to touch `inventory_levels`. A nightly reconciliation job recomputes `sum(delta)` per variant per store and reports any drift. In four years of running systems like this, drift only ever appears when someone has bypassed the repository, which is exactly what you want the job to catch.

`reason` is an enum: `sale`, `refund`, `receiving`, `transfer_in`, `transfer_out`, `count_adjustment`, `damage`, `expired`, `theft`, `vendor_return`, `promo_giveaway`, `online_order`, `online_cancel`, `manual_adjustment`, `opening_balance`. Manual adjustments require a reason code and a free text note, and they are surfaced in the loss prevention report grouped by employee.

### Reservations

```
on_hand 5, reserved 2  →  available 3
```

`inventory_reservations` holds `(variant_id, store_id, qty, reason, reference_id, state, expires_at)`. Checkout on the storefront creates a reservation with a 15 minute TTL at the moment the cart enters payment. Payment capture promotes it to `committed`. Payment failure, cart abandonment or expiry releases it via a sweeper job running every 60 seconds. `reserved` is maintained as the sum of active reservations, with a CHECK that it cannot go negative.

In store sales do not reserve. They decrement directly, because the product is physically leaving the counter and there is no window in which a reservation would help.

### Counting

`inventory_counts` with modes `full`, `cycle`, `spot`, `category`, `vendor`. Each `inventory_count_line` snapshots the expected quantity at the moment the line is created, not at the moment the count is posted, so a sale during the count does not silently become a variance. Posting a count generates `count_adjustment` ledger entries for the net difference and shows expected quantity, counted quantity, unit variance, cost variance and retail variance before anyone commits. Counting runs on any Android device with the app, including a cheap phone with the camera scanner, not just the register.

### Purchasing, receiving and cost

Purchase orders follow `draft → submitted → confirmed → partial → received → closed`, with `cancelled` reachable from the first three. Receiving supports partial quantities, cost changes at receipt time and an invoice number, and generates `receiving` ledger entries.

Every receipt also writes a **cost layer**: `(variant_id, store_id, qty_received, qty_remaining, unit_cost, received_at)`. Weighted average cost is what the reports use on day one:

```
new_avg = (on_hand × old_avg + received_qty × received_cost) / (on_hand + received_qty)
```

The cost layers are written anyway, even though nothing consumes them yet, because switching to FIFO later without them requires reconstructing history that no longer exists. This costs one small insert per receipt line and buys a costing model change whenever you want one.

### Forecasting

Statistical first, machine learning only if it earns its place. Nightly job per store per variant:

```
demand window   = trailing 56 days, EXCLUDING days where the item was out of stock
                  (stockout days read as zero demand and drag every forecast down;
                   this single correction is worth more than any model choice)
ADS             = exponentially smoothed daily sales, α = 0.3
                  with a day-of-week multiplier from the trailing 8 weeks
intermittent    = if sales occur on fewer than 30% of days, use Croston's method
                  instead of smoothing. Disposable flavors behave this way.
σ               = stdev of daily demand over the window
safety_stock    = z(service_level) × σ × sqrt(lead_time_days)
reorder_point   = ADS × lead_time_days + safety_stock
days_of_supply  = available / ADS
stockout_date   = today + days_of_supply
order_qty       = round_to_case(ADS × (lead_time + target_cover_days) - available)
```

Output goes to `reorder_recommendations`, which is what the purchase order builder reads. Every parameter in that block (`α`, window length, service level, target cover, whether to round to case quantity) is a per organization, per category or per vendor setting with a sane default. Owners override forecasts and the override is recorded, which gives you labeled training data for free if you later want a model.

Example output, exactly as the brief describes it:

```
Geek Bar Pulse X · Miami Mint
On hand 12 · reserved 0 · available 12
ADS 3.2/day (56d, 4 stockout days excluded) · σ 1.4
Vendor lead time 4 days · service level 95%
Safety stock 5 · reorder point 18  ← below reorder point
Days of supply 3.8 · projected stockout Sat Sep 12
RECOMMEND: order now, 24 units (2 cases of 12)
```

---

## G. ONLINE ORDER FLOW

```
 STOREFRONT                  API                     POSTGRES              REGISTER
     │                        │                          │                     │
 1.  │ browse ────────────────▶ availability = on_hand - reserved
     │                        │  (cached 10s in Redis, invalidated by
     │                        │   InventoryChanged events)
     │                        │
 2.  │ add to cart ───────────▶ COMPLIANCE CHECK #1
     │                        │  channel=online, jurisdiction=delivery address
     │                        │  or store jurisdiction for pickup
     │                        │  ✗ → item cannot be added, reason shown
     │                        │
 3.  │ checkout ──────────────▶ COMPLIANCE CHECK #2 (full cart + address + method)
     │                        │  AGE VERIFICATION (Section I)
     │                        │  CREATE inventory_reservations, TTL 15 min ─────▶
     │                        │  CREATE order (status=pending_payment)
     │                        │
 4.  │ pay ───────────────────▶ PaymentProvider.authorize(token, amount)
     │                        │  idempotency key = order_id
     │                        │  ✗ fail → release reservations, order=payment_failed
     │                        │  ✓ → capture, order=confirmed
     │                        │      reservations → committed
     │                        │      EMIT OnlineOrderCreated ──────────────────▶
     │                        │                                        FCM push
 5.  │                        │                                  ┌─────────────┐
     │                        │                                  │ NEW ONLINE  │
     │                        │                                  │ ORDER #10523│
     │                        │                                  │ chime + card│
     │                        │                                  └─────────────┘
     │                        │                                  Accept / Reject
 6.  │                        │◀─────────────────── status: preparing
     │ ◀─ SMS/email + live page
     │                        │◀─────────────────── status: ready
     │                        │
 7a. PICKUP   customer arrives → cashier scans order QR or searches by name
     │                        │  ID check if any line requires it (in person, same
     │                        │  flow as an ordinary age restricted sale)
     │                        │  handover → inventory ledger entry `online_order`
     │                        │  order=completed
     │
 7b. DELIVERY  cashier taps Request Driver
     │                        │  DeliveryProvider.eligibility(cart, address) ← Section H
     │                        │  ✗ → order cannot be delivered, refund or convert to pickup
     │                        │  ✓ → createDelivery() → delivery_jobs
     │                        │      webhooks → delivery_events → live map for customer
     │                        │      handoff verification at the door
     │                        │      delivered → inventory ledger → order=completed
```

Double click protection is the idempotency key on step 4. Two clicks produce one authorization and one order. Overselling protection is the reservation in step 3 combined with a database level CHECK that `reserved <= on_hand` cannot be violated, so the race between a storefront checkout and a counter sale resolves in the database rather than in application logic.

---

## H. DELIVERY ARCHITECTURE

### The abstraction

```kotlin
interface DeliveryProvider {
  val id: String
  suspend fun eligibility(ctx: DeliveryContext): EligibilityResult   // MUST be called first
  suspend fun quote(ctx: DeliveryContext): List<DeliveryQuote>
  suspend fun create(job: DeliveryJobRequest): DeliveryJob
  suspend fun cancel(jobId: String, reason: String): CancelResult
  suspend fun track(jobId: String): DeliveryStatus
  fun verifyWebhook(headers: Map<String,String>, body: ByteArray): Boolean
}
```

`eligibility()` is separate from `quote()` on purpose, and it is a hard gate. It takes the cart, the destination, the store and the current time, and returns a per line verdict. It consults, in order: the provider's own restricted category list, the merchant's contractual status with that provider, the compliance engine's jurisdiction rules, and whether the provider can perform the age verification that the product requires. Any line that fails blocks the whole provider. There is no path in the code from cart to `create()` that does not pass through `eligibility()`, and that is enforced by the type system: `create()` takes a `DeliveryJobRequest` that can only be constructed from an `EligibilityResult.Approved`.

### What you can actually deliver, as of September 2026

This is the part that changes the product, so it belongs in the architecture document rather than a footnote.

**Uber Direct prohibits nicotine and tobacco entirely.** Their prohibited items list covers vaping products, chewing tobacco, rolling papers, nicotine pouches and hookahs across Uber Eats, Postmates and Uber Direct. Build the adapter, because it is the right courier for any non nicotine category you carry, but do not plan nicotine delivery around it.

**DoorDash does not allow tobacco on its marketplace**, and its merchant guidance says vapes, e-cigarettes and nicotine products are excluded for all merchants and all order types. There is a narrow exception: in jurisdictions where it is legal, merchants holding a **tobacco specific agreement with DoorDash** can request Dasher delivery of tobacco the customer bought through the merchant's own channels, with Dashers 21+ and ID verification at the door. That is the DoorDash Drive white label path, it requires a negotiated agreement, and it is not something you can self serve.

**Therefore the first `DeliveryProvider` implementation is `OwnDriverProvider`**, not a third party. Your own employee, your own vehicle, dispatched from the register, with the driver app performing an ID scan and capturing a signature at handoff. This is the only channel you fully control, it is the only one certain to be available for nicotine, and it happens to be the cheapest per delivery at low volume. The third party adapters sit behind the same interface for the categories they will carry.

**Before any of that ships, the legal question has to be answered, and it is not a small one.** Under the PACT Act an online sale of ENDS to a consumer who is not physically present is a "delivery sale", and ATF's guidance is explicit that this applies whether the USPS, a common carrier **or your own delivery service** is used, for sales in interstate commerce. A purely intrastate Texas delivery is a different analysis, but Texas has its own hook: the Comptroller requires an e-cigarette retailer permit for anyone who intends to sell, store or **make a delivery sale** of e-cigarette products to consumers in Texas, and that expressly includes selling by internet, telephone or mail order. The cigarette and tobacco retailer permit carries the same language.

Concretely: local delivery of nicotine is a compliance project with an attorney, a permit review and probably monthly reporting obligations attached, not a sprint ticket. The architecture supports it fully. Turning it on is a business decision that needs counsel first, which is why it sits in Phase 6 and behind a feature flag that ships in the off position.

### Zones and workflow

`delivery_zones` supports radius, ZIP list and GeoJSON polygon, evaluated with PostGIS `ST_Contains`, each with its own minimum order, fee, free delivery threshold, maximum distance and delivery hours. Zone evaluation happens at address entry, again at checkout and again at dispatch, because the customer can sit in checkout past the end of delivery hours.

`delivery_jobs` and `delivery_events` are append only. Provider webhooks are verified by signature, deduplicated by provider event id, and processed idempotently, because every courier API in existence will deliver you the same webhook twice.

---

## I. AGE AND COMPLIANCE ARCHITECTURE

### Why this is the most important subsystem in the product

Your categories moved three times in the last twelve months. Since September 2025 Texas has prohibited the sale of any vape or e-cigarette containing cannabinoids. Since October 2025, extended by rule in January 2026, consumable hemp products require 21+ with government issued ID verification statewide. New DSHS rules effective March 31 2026 changed the THC calculation to count THCA toward the total, which pulled most smokable hemp flower and pre-rolls out of legal retail. Texas began enforcing Schedule I definitions covering manufactured delta-8, delta-10 and THCP on July 31 2026. And federal H.R. 5371 redefines hemp effective **November 12 2026**, roughly two months from now, in a way that is expected to capture most intoxicating consumable hemp products.

Given the products in your shop, at least two of those changes have already hit your shelves and a third arrives in November. Confirm all of it with your attorney rather than with me, and treat the dates above as pointers to check, not as legal advice.

The architectural consequence is not ambiguous: **a compliance engine that hard codes today's rules is obsolete before it ships.** Rules are rows, with effective dates, and the owner can flip an entire category off at 11pm on a Tuesday without a deploy.

### Rule model

```
compliance_rules
  id, org_id (nullable = platform default), priority,
  scope: country / state / county / city / store_id
  subject: category_id / brand_id / variant_id / attribute match (jsonb)
  channel: in_store | pickup | delivery | online_listing | ship
  effect:  ALLOW | DENY | REQUIRE_AGE(n) | REQUIRE_ID_SCAN
           | REQUIRE_MANAGER | REQUIRE_PROVIDER_VERIFICATION
  effective_from, effective_to,          ← time travel is mandatory
  authority_note, created_by, created_at ← why this rule exists, for the auditor
```

Evaluation is deterministic and ordered: most specific scope wins, then highest priority, then `DENY` beats `ALLOW` on a tie. The evaluator is pure, takes an explicit `asOf` timestamp, and is covered by the same style of JSON fixture suite as the pricing engine. It ships identically in TypeScript and Kotlin so the register enforces the same rules offline.

**The engine fails closed.** If eligibility cannot be established (no rule matches, rule data is stale beyond its freshness window, a required provider is unreachable) the answer is deny, with a reason string the cashier can read. A manager can override an in store denial only where a rule marks itself overridable, and the override is written to the audit log with the manager's identity attached.

### In store verification

```
line added → engine returns REQUIRE_AGE(21) + REQUIRE_ID_SCAN
   │
   ▼
┌──────────────────────────────────┐
│   ⚠  AGE VERIFICATION REQUIRED   │
│   Delta 9 Gummies 10mg           │
│   Minimum age 21                 │
│                                  │
│   [ SCAN ID ]  [ VERIFY MANUALLY ]  [ REMOVE ITEM ]
└──────────────────────────────────┘
```

ID scanning parses the AAMVA PDF417 barcode **on the device**. The parser extracts date of birth and expiry, computes pass or fail, and discards everything else immediately. It never transmits the raw barcode payload and it never writes it to disk.

What is stored is the minimum that proves the check happened:

```
age_verifications: sale_id, line_id, method (scan|manual|provider),
                   result (pass|fail|expired_id|unreadable),
                   verified_at, employee_id, register_id, minimum_age_applied
```

No name. No address. No license number. No image. Several states restrict what may be retained from a scanned license, so retention of anything beyond this is a per organization setting that defaults to off, and turning it on requires typing a legal basis into a field that lands in the audit log.

### Online verification

The storefront age gate is a deterrent, not a control, and the code treats it that way. Real verification runs through `AgeVerificationProvider` (Veratad, IDScan.net, Token of Trust and similar), which returns approved or rejected plus a token. We store the token, the provider, the result and the timestamp. We never store the documents they collected.

Age verification happens **before payment**, not after, so a rejected customer is never charged. For delivery, the compliance engine additionally requires that the chosen delivery channel can perform verification at handoff, which for `OwnDriverProvider` means the driver app runs the same on device scanner the register does.

---

## J. HARDWARE ARCHITECTURE

```kotlin
interface HardwareManager {
  val devices: StateFlow<List<HardwareDevice>>   // live capability registry
  fun <T : HardwareDevice> require(cap: Capability): T?
  suspend fun probe(): List<DiscoveryResult>
}

interface ScannerProvider  { val scans: Flow<ScanEvent> }
interface PrinterProvider  { suspend fun print(doc: ReceiptDocument): PrintResult
                             suspend fun openDrawer(): DrawerResult
                             suspend fun status(): PrinterStatus }
interface CustomerDisplayProvider { fun show(state: CustomerDisplayState) }
interface CardReaderProvider { suspend fun collect(req: PaymentRequest): PaymentOutcome }
interface ScaleProvider / LabelPrinterProvider / SignatureProvider
```

Capability based, not device based. Checkout asks for "a printer that can open a drawer" and does not know or care whether that resolves to an Epson on ethernet, a Sunmi built in head or nothing at all.

**Scanners.** Two paths. Most retail scanners present as HID keyboards, which need zero configuration: a global key event interceptor collects characters and commits the buffer when inter key timing exceeds a threshold (default 35ms) or a terminator arrives. Suffix configuration is auto detected on first scan during setup. Integrated scanners on Sunmi, PAX, Urovo and similar devices go through vendor SDK adapters, loaded reflectively so the APK does not require every vendor SDK to be present.

**Printers.** ESC/POS over TCP 9100, USB host and Bluetooth SPP, with paper width (58mm or 80mm) as a render parameter rather than a separate template. The receipt renderer produces an abstract `ReceiptDocument` and the driver rasterizes it. This means a receipt looks correct on any width and can be rendered to PNG for email or SMS receipts using the same code.

**Cash drawer** opens via the printer kick command (`ESC p m t1 t2`, typically `1B 70 00 19 FA`). Standalone USB drawers get their own adapter. Every drawer open, including no sale opens, writes an audit record with employee, register, reason and timestamp, which is where the loss prevention reports get their signal.

**Customer display.** Android `Presentation` API on a secondary display for dual screen terminals such as the Sunmi T2 or D3, and a separate paired tablet app over local WebSocket for standalone setups. Both consume the same `CustomerDisplayState`.

**Recommended hardware for store one:** Sunmi T3 Pro or Elo Pay for the register (integrated printer, scanner and customer display, one power cable), an ethernet Epson TM-m30III as a backup printer, an entry level 2D scanner on the counter for fast repeat scanning, and a Brother QL-820NWB for shelf labels.

The rule the brief asks for, restated as a CI check: nothing in `feature-register`, `feature-cart` or `feature-payment` may import from `hardware-*` except `hardware-api`. Checkout logic cannot know what a Sunmi is.

---

## K. SECURITY MODEL

### Identity and sessions

Argon2id password hashing (`m=64MB, t=3, p=4`). Access tokens are 10 minute JWTs; refresh tokens are opaque, stored hashed, rotated on every use, and **reuse detection revokes the whole family**, which is what turns a stolen refresh token from a persistent backdoor into a one shot that gets caught.

Registers authenticate as devices, not as people. A device enrollment produces a long lived, rotating device credential bound to `(org_id, store_id, register_id)` and to an Android Keystore backed key. Employees then unlock the device with a PIN. The PIN is Argon2id hashed and cached on device with the employee's permission set so the register works offline, and PIN changes propagate on the next sync. Certificate pinning on the API host. A remote wipe command that clears the Room database, sent via FCM, for the day a terminal walks out the door.

### Authorization

Roles map to permission sets; permissions are checked in the API layer via a guard and again in the domain service, because defense in depth means the check that protects you is the one you forgot you wrote. The register enforces the same permission set locally so an offline cashier still cannot issue an unauthorized refund. Sensitive operations (refund above a threshold, price override, cost visibility, customer export, employee creation) require manager PIN re-authentication at the moment of the action, not merely a manager being logged in somewhere.

Tenancy is enforced three ways: `org_id` on every query through the repository layer, composite foreign keys that make cross tenant references impossible to insert, and row level security as a backstop.

### Payment security

**No card data ever enters this system.** Not the PAN, not the track data, not the CVV, not in logs, not in memory.

The architecture is **semi integrated**: the register sends an amount to a PCI validated P2PE terminal, the terminal handles the card independently and returns an approval plus a provider token. Our database stores the token, the last four, the card brand, the auth code and the amount. This is not merely good practice, it is the difference between a short SAQ B-IP or P2PE self assessment and a full SAQ D audit, and for a business this size that difference is roughly the cost of an engineer.

Gateway reality check: **Stripe, Square and PayPal all prohibit vape and nicotine products.** Building checkout on any of them means your funds get frozen the day underwriting notices what MCC 5993 means. You need a high risk merchant account underwritten for tobacco, with a gateway such as NMI, Authorize.Net, USAePay or PayTrace behind it. The `PaymentProvider` interface is what makes this a configuration change rather than a rewrite, and it is why the interface ships in Phase 2 even though the first real adapter lands in Phase 3.

### Data protection

TLS 1.3 everywhere, HSTS, strict CSP, `SameSite=Lax` cookies, CSRF tokens on cookie authenticated routes. Rate limiting per IP, per user and per device, with much tighter limits on auth and refund endpoints. Zod validation on every request body, with the same schema generating the OpenAPI document, so an endpoint cannot accept a field it never documented. Parameterized queries only, enforced by lint rule.

Secrets live in a manager and are injected at runtime. A pre commit hook and a CI secret scanner both run, because one of them will eventually be bypassed. Database backups are encrypted, with point in time recovery, and **the restore procedure is tested quarterly against a scratch environment**. An untested backup is not a backup.

Customer PII is minimized by design: no date of birth unless the customer volunteers it for a birthday reward, no ID data, no card numbers. Export and deletion workflows exist from Phase 3. Deletion anonymizes the customer record and severs it from sales while leaving the sales themselves intact, because financial records cannot disappear and a refund still has to be possible against a transaction whose customer exercised a deletion right.

---

## L. DEVELOPMENT ROADMAP

Estimates assume two experienced engineers working full time, or one engineer plus AI assistance at roughly half that pace. They are honest, not optimistic.

| Phase | Milestone | Ships | Effort |
|---|---|---|---|
| **0** | Foundation | Monorepo, CI, dev and staging environments, migrations run, seed data, OpenAPI pipeline, contracts package | 2 weeks |
| **1** | Catalog and identity | Orgs, stores, registers, users, roles, permissions, products, variants, categories, barcodes, prices, inventory ledger and levels, Android shell that authenticates and syncs the catalog offline | 5 weeks |
| **2** | **The register works** | Cart, scan, search, promotions v1, tax, cash checkout, receipts, printer and drawer adapters, cash sessions, refunds, holds and parks, audit log, offline sync end to end, age prompt with on device ID scan | 7 weeks |
| | **← First store can run its counter on this. This is the real milestone.** | | |
| **3** | Payments and customers | PaymentProvider + semi integrated terminal, customers, loyalty, gift cards, store credit, full promotions engine | 6 weeks |
| **4** | Owner platform | Admin dashboard, bulk product editing, CSV and XLSX import with mapping wizard, vendors, purchase orders, receiving, counts, all core reports, exports | 8 weeks |
| **5** | Online store | Storefront, accounts, real time availability, reservations, pickup orders, online orders on the register | 7 weeks |
| **6** | Delivery and compliance | Compliance rule engine UI, own driver delivery, delivery zones, tracking, AgeVerificationProvider, third party courier adapters | 6 weeks |
| **7** | Marketing | SMS with consent and STOP handling, email, segmentation, automations | 5 weeks |
| **8** | Purchasing automation | EDI provider framework, 850, 855, 856, 810, vendor catalog ingestion, automated POs | 6 weeks |
| **9** | Intelligence | Forecasting, reorder recommendations, anomaly detection, loss prevention scoring, AI assist | 5 weeks |
| **10** | Multi store and SaaS | Transfers, consolidated reporting, tenant hardening, plans, billing, onboarding | 6 weeks |

Phases 3 and 4 can run in parallel with two engineers. Phase 8 is the one most likely to slip, for reasons in Section M.

**A note on sequencing given where you are.** You are mid migration from Modisoft to Fastrax. Keep going. The earliest this platform could responsibly run your counter is roughly four months of focused work, and the shop needs a working POS on Monday. Treat Fastrax as the system of record for now and this as a parallel build, which also has the advantage that a year of real Fastrax data gives you something to import and something to check the forecasting against.

---

## M. PROJECT RISKS

Ranked by how likely they are to actually stop you.

**1. Payment processing. Not an engineering risk.** Stripe, Square and PayPal prohibit your category. You need a high risk merchant account underwritten for MCC 5993 plus a gateway (NMI, Authorize.Net, USAePay, PayTrace). Underwriting takes days to weeks, requires your permits and licenses, and can be withdrawn later if chargebacks spike. **Start this application now, in parallel with Phase 1**, because Phase 3 cannot be tested without a sandbox account and sandbox access generally follows approval.

**2. Regulatory velocity in your specific categories.** Covered in Section I. Texas hemp rules changed three times in twelve months and the federal hemp redefinition lands November 12 2026. This is not a risk the software can eliminate; the architecture can only make you fast to respond. Budget for a compliance review with counsel before Phase 6 ships, and again before the storefront lists a single regulated SKU.

**3. Delivery of nicotine.** Uber Direct will not carry it. DoorDash requires a negotiated tobacco agreement that is not self serve. PACT Act delivery sale obligations and the Texas e-cigarette retailer permit's delivery sale language both need an attorney's read before you dispatch a single order. The engineering is straightforward; the permission is not.

**4. Offline correctness.** The hardest code in the project. Mitigated by the idempotency design, by the fact that sales are append only facts rather than mutable state, and by a test harness that runs the register against a proxy which drops, delays, duplicates and reorders requests. That harness is built in Phase 2, not bolted on later.

**5. EDI.** The brief assumes vendors have EDI. Most smoke shop distributors do not. Many send a PDF invoice by email, some have a web portal, a few have an API and a very small number do true X12 over SFTP or AS2. The realistic Phase 8 is an **invoice ingestion pipeline** (email intake, PDF and CSV parsing, line matching against the PO, human confirmation) with an X12 adapter for the two or three vendors who support it. Planning pure X12 is planning for a world that is not yours. Trading partner testing with each vendor takes weeks per vendor regardless.

**6. Two pricing engines drifting.** Mitigated by the conformance fixture suite in Section B. If that suite is ever allowed to be skipped in CI, this becomes the number one risk instead.

**7. Data migration and go live inventory accuracy.** The system will be exactly as accurate as the count you start it with. Plan a full physical count on go live weekend, not a data export. Modisoft export field mapping is Phase 4 work and should be tested against a real export months before you need it.

**8. PCI scope creep.** Any decision that puts card data in the app (a cheap non P2PE reader, a "temporary" manual entry screen) converts a short self assessment into a full audit. This is a one way door. The interface is designed to make the wrong choice impossible to express.

**9. Scope.** Twenty nine numbered feature areas. The single most likely failure mode for this project is building 40 percent of everything and shipping nothing. Section N exists to prevent that.

---

## N. MVP DEFINITION

**Version 1 is: one store, one to three registers, cash and card, accurate inventory, and an owner dashboard. Nothing online.**

That is Phases 0 through 4. Roughly four months to a usable counter (end of Phase 2) and eight months to the full v1.

### In v1

Organizations, stores, registers, devices. Users, roles, fine grained permissions, PIN unlock, time clock. Products, variants, hierarchical categories, brands, multiple barcodes per variant, per store pricing. Inventory ledger, levels, counts, adjustments with reason codes. The register: scan, search, favorites, category tiles, cart operations, line and cart discounts, price override with manager approval, tax exemption, notes, hold, park, resume. Cash and semi integrated card payment, split tender, tips if configured. Receipts printed, emailed or skipped. Cash drawer sessions, blind counts, over and short, shift reports. Refunds, partial refunds, voids, exchanges, store credit. Offline first operation with the full sync design. Age verification with on device ID scan and the compliance rule engine (because your categories require it on day one, not later). Audit log and loss prevention reports. Admin dashboard with bulk editing, import and export, vendors, purchase orders, receiving and the core report set. Promotions v1: percent off, amount off, BOGO, mix and match, category and brand discounts, time windows.

### Not in v1, but the architecture already accommodates

Online store, delivery, loyalty (the tables exist, the engine is Phase 3), gift cards, SMS and email marketing, EDI, forecasting, multi store, AI features.

### The line that defines v1

**Ship nothing in v1 that cannot be operated by a cashier who received twenty minutes of training, and ship nothing that makes a sale slower.** Every feature above either happens at the counter and must be instant, or happens in the back office and can take a second to load.

---

## O. UI DIRECTION

### Design tokens

```
Type    Inter Variable (UI) · tabular numerals MANDATORY on every money figure
        JetBrains Mono for SKUs, barcodes and receipt previews
Scale   12 / 14 / 16 / 20 / 24 / 32 / 48 · 8pt spacing grid
Radius  6px controls · 12px cards · 999px pills
Motion  ≤150ms, ease-out. ZERO animation on the scan-to-cart path.
        A row that animates in is a row the cashier waits for.
```

Money in a proportional font is the single most common way a retail interface looks cheap. Digits must be the same width so columns of prices align and a changing total does not shimmer.

### The register

Dark by default. Not a stylistic preference: a bright screen behind a counter for a ten hour shift is fatiguing, and a dark surface makes the cart the brightest thing in the room, which is where the cashier's eyes should be. Light mode is fully supported and is a per device setting.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⬤ Online    Register 1 · Maria       [⌘K search]      14:32   ⚙        │
├────────────┬─────────────────────────────────────┬───────────────────────┤
│            │                                     │                       │
│ FAVORITES  │  ┌────────┐ ┌────────┐ ┌────────┐   │  CART          4 items│
│ ─────────  │  │        │ │        │ │        │   │  ──────────────────── │
│ Vapes      │  │ Geek   │ │ Geek   │ │ Lost   │   │  Geek Bar Pulse X     │
│ Tobacco    │  │ Bar    │ │ Bar    │ │ Mary   │   │  Miami Mint           │
│ Glass      │  │ Miami  │ │ Blue   │ │ BM6000 │   │  2 × 24.99     49.98  │
│ Hemp       │  │ Mint   │ │ Razz   │ │        │   │  ⚑ 21+ verified       │
│ Drinks     │  │ 24.99  │ │ 24.99  │ │ 19.99  │   │                       │
│ Snacks     │  └────────┘ └────────┘ └────────┘   │  Backwoods Honey      │
│            │                                     │  1 × 6.49       6.49  │
│ ─────────  │  ┌────────┐ ┌────────┐ ┌────────┐   │                       │
│ RECENT     │  │  ...   │ │  ...   │ │  ...   │   │  Monster Ultra        │
│ Backwoods  │  └────────┘ └────────┘ └────────┘   │  1 × 3.99       3.99  │
│ Monster    │                                     │  ───────────────────  │
│ Zyn 6mg    │  ⌕ scan or type SKU, UPC, name      │  Subtotal      60.46  │
│            │                                     │  Promo  BOGO   -6.49  │
│            │                                     │  Tax            4.46  │
│ + Customer │                                     │  ───────────────────  │
│            │                                     │  TOTAL         58.43  │
│            │                                     │  ┌─────────────────┐  │
│            │                                     │  │      PAY        │  │
│            │                                     │  └─────────────────┘  │
└────────────┴─────────────────────────────────────┴───────────────────────┘
```

Touch targets 56px minimum, 72px for PAY and the tender buttons. Product tiles 120px square, three to five columns depending on screen width, drag to reorder in a layout edit mode. The search field is always focused so a scan works the instant the app is open, with no tap required. A scan adds to the cart in under 120ms measured from HID input to rendered row, and that number is a performance budget enforced by a benchmark test, not an aspiration.

Keyboard shortcuts throughout for counters with a physical keyboard: `F2` quantity, `F3` discount, `F4` price override, `F8` hold, `F9` customer, `Enter` pay, `Esc` back.

### The dashboard

Light by default, dark available. Dense but not cramped: a shop owner checking margin on a phone at 11pm needs numbers per screen, not whitespace per screen. Single accent color used only for actions and never for decoration, so that when something is blue it means something. Charts in muted tones with one accent series, no gradients, no drop shadows on data. `⌘K` command palette over products, customers, orders, vendors, purchase orders and employees from day one, because it is the fastest thing in any admin interface and it is cheap to build early and expensive to retrofit.

The test for every dashboard screen: could the owner answer the question this screen exists to answer in under five seconds, without scrolling, on a phone.
