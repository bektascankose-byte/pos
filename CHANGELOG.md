# Changelog

Notable changes. Newest first.

## Phase 2 — Invoice ingestion, part 2: file upload, object storage, and CSV parsing

The third phase of the AI-assisted invoice-ingestion system: a real upload endpoint and a real
dashboard page, proving upload → object storage → the staging table round-trips correctly before any
AI dependency enters the picture. No catalog matching yet -- a CSV's own header row is enough to
separate quantity/cost/description/SKU without spending a token on it; PDF/image extraction and AI
matching are the next slices.

- **Object storage**: new `apps/api/src/platform/storage/` (`ObjectStorageService`), speaking the S3
  API against MinIO in development (already running in the dev stack, per `docs/INTEGRATIONS.md` --
  but with no bucket provisioned anywhere) and Cloudflare R2 in production later, same API. Creates
  its bucket on boot if missing, the same defensive-check-at-startup shape `DatabaseService` already
  uses for its own owner-role check.
- **Multipart upload**: `@fastify/multipart` registered in `main.ts`. The connection-level `bodyLimit`
  moved from 8 MiB to 20 MiB to fit an uploaded invoice (a scanned PDF or a phone photo) through the
  same ceiling every route shares -- Fastify checks this before any body parser runs, so a per-route
  override can't let a large upload through a smaller global one. The actual per-file cap is
  `@fastify/multipart`'s own 15 MiB `fileSize` limit, tighter than the connection ceiling around it.
- New `apps/api/src/modules/invoicing/` module: `POST /invoice-imports` (multipart: a file plus
  `store_id`/`vendor_id`, refused up front for any content type that isn't PDF/PNG/JPG/CSV/plain-text)
  stores the file and creates the staging row at `status='uploaded'`; `POST
  /invoice-imports/:id/parse` reads a CSV's header row to separate quantity/unit cost/description/
  vendor SKU (recognizing common header spellings -- `qty`, `unit cost`, `sku`, and their usual
  variants -- regardless of spaces, hyphens, or case) and inserts one staging line per row. A
  non-CSV file refuses parsing with a clear "not built yet" message rather than guessing; a malformed
  CSV lands the whole import on `status='failed'` with `parse_error` set -- a 200 a reviewer can act
  on, not a 500. No new permissions -- reuses `purchasing.view`/`purchasing.create`, the same gate a
  real purchase order already sits behind.
- Found and fixed a real parsing bug during verification: the header-matching only compared exact
  alias strings (`unit_cost`), so a real CSV's `"Unit Cost"` header (spaces, not underscores) matched
  nothing and silently left every line's cost blank. Fixed by normalizing both the CSV's own headers
  and the alias list to letters-and-digits-only before comparing, so `"Unit Cost"`, `"unit-cost"`, and
  `"unit_cost"` are recognized as the same header.
- `apps/dashboard/lib/api.ts`'s `apiFetch` gained a `FormData` carve-out -- it was unconditionally
  setting `Content-Type: application/json` on every request with a body, which silently breaks a
  multipart upload (the browser's own boundary header never gets attached). Dashboard:
  `/invoice-imports` (list), `/invoice-imports/new` (upload form, a plain `<input type="file">` --
  Next.js Server Actions handle a `File` field with no extra encoding setup), `/invoice-imports/[id]`
  (status, a "Parse this invoice" button, and the resulting line table once parsed).

Verified against the real dev database, real MinIO, and through the dashboard's own UI: confirmed the
bucket gets created on boot when none exists; uploaded a real CSV (including the "50 Boxes Assorted
Flavor" line this whole system exists to eventually handle) through the browser's own file input,
parsed it, and confirmed every line's quantity/cost/description/SKU came out right; confirmed an
unsupported file type is refused before storage, a non-CSV parse attempt fails clearly, and a
malformed CSV lands on `status='failed'` with a readable error instead of a 500; confirmed a
cashier-role token is refused for missing `purchasing.view`. Cleaned up all test data (database rows;
the handful of orphaned test objects left in the dev MinIO bucket are inert and harmless).

## Phase 2 — Invoice ingestion, part 1: staging schema and a purchasing refactor

Pure schema and a mechanical refactor, no new endpoint or dashboard page yet -- the second phase of
the AI-assisted invoice-ingestion system planned this session, laying the ground the rest of it
builds on.

- New migration `0014_invoice_imports.sql`: `invoice_imports` (one row per uploaded vendor invoice --
  file reference, vendor/store, parsed total, status through `uploaded → parsed → reviewed →
  committed`/`failed`) and `invoice_import_lines` (raw text, parsed quantity/cost/description/vendor
  SKU, and a full set of `ai_suggested_*`/`ai_confidence` columns). No new permissions -- an invoice
  import graduates into a real purchase order and reuses `purchasing.*` exactly as one already does.
  `split_from_line_id` gives "Add Variants" its lineage: a line a vendor described ambiguously (several
  flavors folded into one line item) flips to `status='split'` once a human resolves it, and each
  variant they create becomes a new sibling row pointing back at it.
  **The one rule carried through every column here**: AI only ever writes a `ai_suggested_*` or
  `ai_confidence` value. Nothing in this schema, and nothing planned on top of it, lets an extraction
  step create a product, change a price, or move stock by itself -- every real mutation happens
  because a human clicked a button that calls a real, permission-gated endpoint, with the suggestion
  as a starting point rather than an instruction.
- **Why a refactor had to come with it**: `po_receipt_lines.po_line_id` is a hard, `NOT NULL` foreign
  key to `purchase_order_lines(id)` -- there is no way to receive stock without a pre-existing PO
  line, which means committing an invoice that never had a formal PO (the common case for this
  vertical) has to *synthesize* one first, then receive against it, atomically. `PurchasingService`'s
  `createPurchaseOrder`/`receivePurchaseOrder` are now thin `withOrg` wrappers around new
  `createPurchaseOrderTx`/`receivePurchaseOrderTx` methods that take a transaction directly -- the
  same shape the file already used for its private `loadPurchaseOrder` helper -- so a future
  invoicing service can compose both inside one shared transaction instead of two separate ones that
  could partially fail. `receivePurchaseOrderTx` also gained optional `document_url`/
  `invoice_total_minor` parameters, finally giving `po_receipts`' two matching columns (present in
  the schema since the very first purchasing migration, written by nothing) a way to get populated.
  Zero behavior change to the two existing routes.

Verified against the real dev database: ran the exact same create-PO → partial-receive →
idempotent-replay sequence through the live API both immediately before and immediately after the
refactor (same vendor, same variant, same quantities) and confirmed structurally identical results at
every step -- same status transitions, same computed totals, same stock delta, same idempotency-replay
behavior -- before trusting anything to be built on top of it. Sanity-checked the new tables directly
against the live database (default status, the ambiguous-line flag, the confidence-range check
constraint rejecting an out-of-bounds value) since nothing calls them yet. Re-ran the full Postgres
and PGlite schema suites for the migration's updated counts.

## Phase 2 — Back office, eighth slice: add variants, bulk edit, and price groups

The first two phases of a much larger planned system: AI-assisted invoice ingestion (read a vendor's
PDF/PNG/JPG/CSV/EDI invoice, match its lines against the catalog, predict brand/category when the
invoice doesn't spell them out). That system's full design -- staging tables, a purchasing-service
refactor its commit step depends on, object storage, an OpenAI integration, a matching cascade -- is
written out in full for later rounds; this slice ships only the two pieces that stand on their own
with no new dependency: adding a variant to a product that already exists, bulk-editing several
products at once, and pricing a set of variants as one group. All three were explicit, standalone
asks on their own merits (an ambiguous invoice line -- "50 boxes assorted flavor" -- gets split into
real variants by hand, grouped so their price moves together later), not stubs for the larger system.

- **Add variant**: `POST /v1/catalog/products/:id/variants` fills a real gap -- until now the only
  way to add a variant was whole-product creation; an existing product had no way to gain a new
  flavor/size. Reuses `createVariantSchema`, the exact per-item shape whole-product creation already
  validated with. Recomputes the product's own `has_variants`/`variant_axes` from its variants
  afterward rather than trusting the caller -- the same invariant enforced at creation time, kept
  true independently since a 1-to-2-variant transition is exactly when it would otherwise go stale.
- **Bulk edit**: `PATCH /v1/catalog/products/bulk` finally gives `product.bulk_update` -- a permission
  that has existed, completely unused, since the very first migration -- a real implementation.
  Category, brand, tax category, and status, applied to a list of products in one transaction.
- **Price groups**: new `price_groups` table (`0013_price_groups.sql`) and a nullable
  `product_variants.price_group_id`. `POST /v1/catalog/variants/bulk-price` either forms a group from
  a list of variant ids and prices them together, or reprices an existing group by id with no need to
  re-select its members -- exactly "change their price later, all together." Reuses the same
  close-open `variant_prices` history logic a single variant's price change already used (extracted
  into one shared private method rather than duplicated). Repeating the same variant-id selection
  reuses its existing group instead of minting a new one and orphaning the last -- found and fixed
  during verification, when doing exactly that left stray `price_groups` rows behind.
- Found and fixed a real bug during verification, not code review: the bulk-price endpoint had no
  `store_id`, so it always priced the org-wide default scope -- but every price in this shop's seed
  data is store-specific, so the new price was silently shadowed by the old one and never actually
  showed up. Added `store_id` to `bulkPriceVariantsSchema` (mirroring `setVariantPriceSchema` exactly)
  and had the dashboard action pass the current store, the same as the single-variant price form
  already does.
- Dashboard: an "Add variant" form on the product detail page; a bulk-select column on the catalog
  list (one checkbox per row, plain HTML, no client JS -- `formData.getAll` reads the selection
  server-side) feeding two bulk-action forms, one for field edits and one for group pricing, using
  `<button formAction={...}>` so one shared selection can submit to either server action.

Verified against the real dev database and through the dashboard's own UI: added a variant to a
4-flavor product and confirmed `variant_axes`/`sort_order`/`is_default` all came out right; bulk-
edited two products' tax category and confirmed only those two changed; formed a price group from
three variants, repriced the *group* (not the individual variants) and confirmed all three moved
together while untouched variants on the same product didn't; confirmed repeating the same selection
reused the group instead of creating a new one. Re-ran the full Postgres and PGlite schema suites
after the migration to confirm the updated counts.

## Phase 2 — Back office, seventh slice: loyalty program settings

Configuration only, no engine. `docs/ARCHITECTURE.md`'s own entity diagram
names `loyalty_accounts`/`loyalty_transactions` as a full points-accrual system
(Phase 3: earning on completed sales, redemption at checkout, both of which
would touch the register app) -- but neither those tables nor anything else
loyalty-related existed anywhere in the schema, contracts, API, or Android
app before this slice. This is genuinely greenfield, unlike scheduling or
purchase orders which at least had a table or a clear shape already. Scoped
by the user to a points-based mechanic, settings only: this stores a
program's name, on/off switch, and rates. Nothing reads these numbers yet --
turning the program on does not change how a sale rings up today.

- New migration `0012_loyalty_settings.sql`: a `loyalty_settings` table, one
  row per org with `org_id` itself as the primary key (a business has one
  loyalty program's settings, not a list of them), plus `loyalty.view` and
  `loyalty.manage` permissions granted to owner/administrator/manager. Kept
  out of `organizations.settings` (the existing generic jsonb bucket) so the
  rates get real column types and `CHECK` constraints instead of living as
  unvalidated JSON. Updated the schema test suite's
  table/FK/enum/check/trigger counts for the new table.
- New `apps/api/src/modules/loyalty/` module: `GET /v1/loyalty/settings`
  (a no-op upsert creates the default row on first read, so there's nothing
  to provision ahead of time) and `PATCH /v1/loyalty/settings`
  (COALESCE-per-column, the same partial-update shape used everywhere else in
  this API). Found and fixed a real Postgres gotcha while testing the update
  endpoint live: `COALESCE($3, 1)` and `COALESCE($4, 100)` -- meant as
  defaults for the `numeric(10,2)` rate columns on a brand-new row -- made
  Postgres infer both parameters as plain `integer`, because a bare literal
  like `1` defaults to that type and a parameter's type has to agree across
  every use of it in one statement. Sending `"2.00"` for an inferred-integer
  parameter fails outright. Fixed by casting the literal defaults
  (`1::numeric`, `100::numeric`) rather than leaving Postgres to guess.
- Dashboard: `/loyalty`, a single settings form (active toggle, name, earn
  rate, redemption rate, optional minimum-redemption floor, optional
  expiration) with an explicit note that no accrual or redemption happens
  yet. Plain server-rendered form, this app's first checkbox input.

Verified against the real dev database and through the dashboard's own UI:
confirmed a fresh org gets sensible defaults on first load with no explicit
setup, saved full settings, made a partial update (toggling just the active
switch) and confirmed every other field stayed exactly as it was, confirmed
invalid input (a blank name, a malformed rate) was rejected before reaching
the database, and confirmed a cashier-role token is refused with
`loyalty.view` missing. Re-ran the full Postgres and PGlite schema suites
after the migration to confirm the updated counts are exactly right.

## Phase 2 — Back office, sixth slice: employee scheduling

A shift roster -- assign employees to upcoming shifts so everyone knows when
to work. Nothing in the schema answered "when is this employee supposed to
work" before this: `time_clock_entries` (0001, still unbuilt behind any API)
only records actual clock-in/out after the fact, and `cash_sessions` is a
register till session, not a work schedule. Scoped by the user to a roster
only -- time clock/timesheets stay deferred, and the register app is
untouched; scheduling is dashboard-only for now.

- New migration `0011_scheduling.sql`: a `shifts` table (`store_id`, `user_id`,
  `starts_at`, `ends_at`, `status` (`scheduled`/`cancelled`), `note`,
  `created_by`) plus two new permissions, `schedule.view` and
  `schedule.manage`, granted to owner/administrator/manager (both) and
  shift_lead (view only). Cancelling a shift is a status change, never a
  `DELETE` -- the same reason most other entities in this schema are
  soft-stated rather than erased -- which also means the table needs no
  `DELETE` grant at all; 0005's blanket `SELECT`/`INSERT`/`UPDATE` already
  covers everything it does. Overlap prevention (an employee can't be
  double-booked) is enforced in the service layer, not a database exclusion
  constraint -- that needs the `btree_gist` extension, which nothing else in
  this schema uses, for a UX nicety rather than a financial or inventory
  invariant. Updated `packages/db/test/migrate.test.mjs`'s schema-shape counts
  for the new table, enum, foreign keys, checks, and trigger.
- New `apps/api/src/modules/scheduling/` module: `GET /v1/scheduling/shifts`
  (a required date range, the same reasoning as the reports module's range
  queries -- an unbounded shift list isn't a useful roster view), `POST
  /v1/scheduling/shifts`, `PATCH /v1/scheduling/shifts/:id` (time and note
  only -- moving a shift to a different employee or store is a
  cancel-and-recreate, not an edit), and `POST
  /v1/scheduling/shifts/:id/cancel`.
- Dashboard: `/scheduling`, a week-at-a-time grid (employee rows × day
  columns, previous/next week navigation) with an add-shift form and a cancel
  button per shift. Built with the same plain server-rendered forms as every
  other page in this app -- no client components, no client-side date-picker
  library.

Verified against the real dev database and through the dashboard's own UI:
created a shift through the schedule grid, confirmed an overlapping shift for
the same employee was rejected with a clear error, rescheduled it, cancelled
it through the UI, and confirmed via direct SQL that the row stayed in the
table with `status = 'cancelled'` rather than disappearing. Re-ran the full
Postgres and PGlite schema suites after the migration to confirm the updated
table/foreign-key/enum/check/trigger counts are exactly right.

## Phase 2 — Back office, fifth slice: inventory management

Stock levels, manual adjustments, movement history, and a full purchase-order
and receiving workflow, added to the dashboard. Low-stock alerts and reorder
recommendations were scoped out of this pass: `stock_alerts` and
`reorder_recommendations` already exist as tables, but nothing computes an
average daily sales rate or a safety-stock number yet, and that's a forecasting
feature that deserves its own scoping conversation, not a byproduct of this one.

- The read and manual-adjustment inventory endpoints already existed
  (`GET /v1/inventory/levels`, `GET /v1/inventory/ledger`,
  `POST /v1/inventory/movements`) with no dashboard UI in front of them at all.
  Added `GET /v1/inventory/stock` and `GET /v1/inventory/stock/:variantId`,
  which start from `product_variants` rather than `inventory_levels` (left
  joining it) and join in product/variant/SKU names -- a variant with no stock
  history yet (just added to the catalog, never received) still shows up, at
  zero, instead of being invisible until its first movement.
- **Purchase orders and receiving are a real new backend module** --
  `apps/api/src/modules/purchasing/` -- since the tables (`purchase_orders`,
  `purchase_order_lines`, `po_receipts`, `po_receipt_lines`, `vendors`) existed
  in the schema from the start with no API in front of them. `line_total_minor`
  is computed as `round(quantity_ordered * unit_cost * 100)` in Postgres numeric
  arithmetic, never in a float. A PO starts at `submitted` rather than `draft`
  -- creating one here means it's been placed with a vendor, not saved
  mid-edit -- and `draft`/`confirmed`/`closed`/`cancelled` aren't wired to any
  UI action in this pass. Receiving posts one `receiving` movement per line
  through the same `InventoryRepository` every other stock change goes through
  (never touches `inventory_levels` directly), requires an `Idempotency-Key`
  for the same reason `POST /inventory/movements` does, and leaves the PO's own
  `subtotal_minor`/`total_minor` exactly as ordered even when a line's received
  cost differs -- that difference is recorded as `cost_changed` on the receipt
  line and `variance_flagged`/`variance_note` on the receipt, not silently
  folded into the PO's original total.
- Dashboard: `/inventory` (stock list), `/inventory/[variantId]` (current
  level, an adjustment form posting a signed quantity with a reason, and
  recent movement history), `/inventory/purchase-orders` (list),
  `/inventory/purchase-orders/new` (vendor picker with an inline "add a vendor"
  fallback when none exist yet, a fixed set of blank line rows rather than a
  client-side add-row control -- consistent with the rest of the app having no
  client components at all), `/inventory/purchase-orders/[id]` (lines,
  ordered/received quantities, and a receive form that defaults every quantity
  to blank rather than the remaining amount, so posting a receipt is always a
  deliberate choice per line, never an accidental full-receive from clicking
  submit without editing anything).
- Fixed a real bug found through browser verification, not code review: the
  purchase-orders list endpoint compared `po.status = $2` where `po.status` is
  the `po_status` enum and `$2` is bound as text -- Postgres has no `=` operator
  across those types regardless of the `$2 IS NULL OR` short-circuit, since SQL
  type-checks the whole expression before evaluating it. Fixed the same way an
  existing sales-list query already had it right: cast the column
  (`po.status::text = $2`), not the parameter.

Verified against the real dev database and through the dashboard's own UI:
posted a count-adjustment through the browser and confirmed the on-hand number
and ledger history updated correctly, then reverted it (a correction is a new
ledger row, never an edit, so the net-zero pair both stay in history, by
design). Created a vendor and a purchase order through the dashboard's own
forms, partially received it, confirmed stock rose by exactly the received
quantity and the status moved to `partial`, received the remainder at a
different unit cost, confirmed the status moved to `received`, the `total_minor`
stayed at the originally ordered amount, and `cost_changed`/`variance_flagged`
were set correctly on the second receipt -- then confirmed a replayed
Idempotency-Key did not double-post the stock. Cross-checked every step against
`GET /inventory/reconcile` (no drift) and direct SQL before removing the test
vendor, PO, and ledger rows.

## Phase 2 — Back office, fourth slice: reports and dashboards

The foundation slice's home page only ever showed "today" -- no date range, no
breakdown beyond a flat list of the last 20 sales. This slice adds a real
`/reports` page: any custom date range (plus Today/Last 7 days/Last 30 days
presets), a daily gross-sales trend chart, and three breakdowns -- top
products (by revenue, not unit count, so a $1 item selling 500 units doesn't
outrank the case that pays the rent), by cashier, and by payment method.
CSV export was scoped out of this pass to keep it focused on in-browser
reporting; the underlying queries are already row-level, so exporting them is
a fast follow-up whenever it's wanted.

- New `packages/contracts/src/reports.ts` additions: `reportRangeQuerySchema`
  (`store_id?`, `from`, `to` -- required, unlike the existing summary query's
  optional range, because a trend or breakdown with no bound is not a useful
  report), and one schema each for a trend point, a top-product row, a
  by-cashier row, and a by-payment-method row (reusing the existing
  `paymentMethod` enum from `sales.ts` rather than redeclaring it).
- Four new `GET /v1/reports/sales/*` endpoints (`trend`, `top-products`,
  `by-cashier`, `by-payment-method`), all gated on the same `report.sales`
  permission the existing summary endpoint uses, all following its exact
  shape: `DatabaseService.withOrg` for RLS-scoped queries, money summed as
  `bigint`-safe strings, and the `($n::type IS NULL OR col = $n)` optional-filter
  idiom instead of building SQL by hand. Top products joins `sale_lines` through
  `product_variants`/`products`/`categories` (a real materialized-path table,
  not a text field); by-payment-method joins `payments` to `sales` and requires
  `status = 'captured'` on a real sale (`sale_id IS NOT NULL`) so a pending,
  failed, or refund-side payment doesn't get counted as tendered revenue.
- Dashboard: `/reports`, added to the nav. A plain `<form method="get">` date
  range plus preset links -- no client-side state, consistent with the rest of
  the app's server-rendered-forms approach. The trend chart is a small inline
  SVG bar chart rather than a charting library dependency, since it's one bar
  per day with no interaction beyond a hover tooltip.

Verified against the real dev database: the four new endpoints' totals
cross-checked exactly against each other for the same range (trend, by-cashier,
and by-payment-method gross all summed to the same $637.83), matching what a
direct SQL aggregate over the seeded sales confirmed independently. Verified
through the dashboard's own UI in a browser: the default 7-day range, the
"Today" preset (correctly empty, matching the home page's own "today" card),
and a custom range submitted through the date-picker form all rendered the
right numbers.

## Phase 2 — Back office, third slice: employee & permissions management

Browse, edit, invite, and manage roles for employees from the dashboard -- the third sequenced slice.
Scoped by the user to cover everything except editing what a role itself grants: `roles.org_id IS
NULL` marks a system role (cashier, manager, owner, ...) as a platform default shared by every
organization, so letting one org's admin edit what one of those grants would be a global change
wearing a per-org settings screen. That stays out of scope; assigning and removing an employee's
role *memberships* does not.

- New `apps/api/src/modules/employees/` module: `GET /v1/employees` (list with assigned role
  names), `GET /v1/employees/roles` (for pickers -- registered ahead of `:id` so Nest doesn't match
  "roles" as an employee id), `GET /v1/employees/:id`, `PATCH /v1/employees/:id`
  (COALESCE-per-column, same partial-update shape as customers and catalog), `POST
  /v1/employees/:id/pin` (upserts `employee_pins`, resetting the failed-attempt lockout), `POST
  /v1/employees/:id/roles` and `DELETE /v1/employees/:id/roles/:userRoleId` (assign/remove one role
  membership), and `POST /v1/employees` to invite a brand-new employee in one transaction (user row,
  one role assignment, optional PIN and/or dashboard password). All gated on the existing
  `employee.view`/`employee.manage` permissions. Reuses the `phone`-or-`email` contactable rule
  already established for customers, as its own `users_contactable` check constraint.
- New `packages/contracts/src/employees.ts`. While wiring it up, found that `identity.ts` already
  had an unused, incorrect `roleSchema` (wrong field names -- `code`/`is_platform` instead of the
  real `key`/`is_system`) plus an unused, incorrect `userSchema`/`createUserSchema` (missing fields,
  wrong status enum) that didn't match the live schema and weren't referenced anywhere in the API or
  the Android app. Replaced them with one corrected `roleSchema` rather than routing around the
  collision, so `identity.ts` stops being a source of wrong information about what a role or a user
  actually looks like.
- Dashboard: `/employees` (list), `/employees/[id]` (own-field edit, role list with remove buttons,
  an add-role picker that excludes roles already held, and a reset-PIN form), `/employees/new`
  (invite form: name, contact, one initial role, optional PIN/password).
- Found and fixed a real bug during browser verification, not just in code review:
  `apps/dashboard/lib/api.ts`'s fetch wrapper sent `Content-Type: application/json` on every
  request, including the no-body `DELETE` that removing a role assignment is -- Fastify refuses that
  combination outright. Confirmed via direct SQL that the failed request never reached the database
  (no partial state), fixed the header to only be sent when there's actually a body, then re-ran the
  same removal through the browser and confirmed it now persists.

Verified end to end against the real dev database and through the dashboard's own UI in a browser:
added and then removed a role from a seeded manager (confirming the DELETE bug above and its fix),
and invited a brand-new employee through the "Add employee" form, confirming their user row, role
assignment, and hashed PIN all landed correctly before removing the test data.

## Phase 2 — Back office, second slice: catalog management

Browse, edit, and add products from the dashboard -- the next sequenced slice after the back
office's foundation. `updateProductSchema` and the full `productSchema` (with variants nested) had
existed in contracts since the beginning with no endpoint behind them; this is what finally calls
them.

- New `GET /v1/catalog/products/:id` (one product, every variant, each variant's barcodes and its
  current price at a given store -- store-specific beats org default, the same precedence
  `scan`/`search` already used), `PATCH /v1/catalog/products/:id` and `PATCH
  /v1/catalog/variants/:id` (both `product.update`, COALESCE-per-column partial updates, the same
  shape as the customer endpoints from the previous slice), and `GET /v1/catalog/brands` /
  `GET /v1/catalog/tax-categories` for the edit form's dropdowns.
- **Price is its own action, never a field edit.** `POST /v1/catalog/variants/:id/price` inserts a
  new `variant_prices` row and closes whatever was open before it, in that order, inside one
  transaction -- because `variant_prices_open_regular_key` models a price as a history, not a
  mutable column, and a plain `UPDATE` would erase the fact that a different price ever existed.
  `updateVariantSchema` deliberately excludes price (and SKU, and barcodes) for the same reason.
- Dashboard: `/catalog` (search, reusing the register's own search endpoint), `/catalog/[id]`
  (product fields, and one form per variant for its own fields plus a separate price-change form),
  `/catalog/new` (single-variant product creation, reusing `POST /catalog/products` -- which
  already existed and needed no changes). Multi-variant products (several flavors of one item) can't
  be created from the dashboard yet; adding a variant to an existing product is a natural next
  addition, not built this round.
- This app has no store switcher yet: `lib/store.ts` reads the org's first store and uses it
  everywhere pricing needs one. Fine while the shop this ships to first has exactly one -- add a
  real selector before a second store exists.

Verified end to end against the real dev database: browsed and opened the seeded "Geek Bar Pulse X"
product, changed one variant's price and confirmed the old `variant_prices` row closed at the exact
instant the new one opened (no gap, no overlap) with a direct SQL query, reverted it, then created a
brand-new single-variant product end to end and confirmed its product/variant/price/barcode rows
all landed correctly before removing the test data.

## Phase 2 — Back office, first slice: foundation, sales dashboard, customers

A back-office web app has never existed in this repo -- only the register and the API. This is the
first slice: a working `apps/dashboard` (Next.js 15 App Router) reachable from a browser, with real
auth, a sales overview, and full customer management. Deliberately not in this slice: catalog
editing, employee/permissions management, EDI, an AI catalog manager, and loyalty settings -- each
is sequenced for its own build, not stubbed out now.

- **Auth is backend-for-frontend, not tokens in browser JS.** The dashboard's own Server Actions and
  Middleware call the API's existing `/v1/auth/login`/`/refresh`/`/logout` -- unchanged, the same
  endpoints the register uses -- and store both tokens as httpOnly cookies the client never sees.
  `middleware.ts` decodes the access token's own `exp` (no signature check needed here; the API
  verifies that on every real request) and refreshes proactively on every matched request, since
  Next.js only allows writing a cookie from Middleware, a Server Action, or a Route Handler -- never
  from a Server Component's render, which is where the actual page data fetching happens.
- **Reporting, additive**: `saleQuerySchema` gained `from`/`to` (the columns already existed;
  `SalesService.list` never applied them until now), and a new `apps/api/src/modules/reports/`
  module adds `GET /v1/reports/sales/summary` (count, gross, tax, average ticket over a range, voids
  excluded) -- gated on the `report.sales` permission that already existed for the sales list.
- **Customers, extended for browsing**: `customerSearchSchema`'s "must supply phone or q" rule
  existed for the register's live-lookup use case; the back office needed to list with no filter at
  all, so the rule is dropped rather than replaced (the register's own call sites are unaffected --
  they always pass one). `q` now also matches phone as a fragment, not just an exact match, since an
  admin's one search box shouldn't need to know the register's phone/name distinction. New
  `PATCH /v1/customers/:id` (`customer.manage`, same gate as create) updates only the fields sent --
  an omitted field keeps its existing value by `COALESCE`, which is also why there's no repeated
  "needs a phone or an email" check on update: this endpoint has no way to null one out.

Verified end to end against the real dev database, not just typechecked: signed in as a seeded
manager, the dashboard's "today" totals came back zero (correctly -- all seeded sales are from the
day before) while an unfiltered range matched a direct SQL aggregate exactly; created, searched by
partial phone, opened, and edited a customer, with the change persisting after a fresh fetch; an
unauthenticated request to a protected route received a 307 to `/login`; and the `auth_sessions`
table's own rotation history showed the middleware's silent refresh firing correctly, unprompted,
several times over the course of testing.

## Phase 2 — Customer attachment

Customers have had a table, a `sale.customer_id` foreign key and `customer.view`/`customer.manage` permissions since the schema's first migration, and the register's own `Cart.customerId`/`withCustomer` since early in the domain layer — nothing on either side ever called it.

Customers are deliberately **not** part of the catalog snapshot or the incremental change feed: caching the customer table on a terminal that can be stolen is a privacy problem with no operational payoff. A register looks a customer up live instead, which makes this the one place the register talks to a fifth kind of endpoint beyond sign in, refresh, pull, and push.

- New `packages/contracts/src/customers.ts` and `apps/api/src/modules/customers/` (search by exact phone or a name/email fragment; get by id; create, gated on `customer.manage` — separate from the `customer.view` search needs, the same split price override draws between reading a permission and reaching for a manager). A customer needs a phone or an email to be reachable, enforced by both the schema's own `customers_contactable` check and the contract's zod refinement.
- `SnapPosApi.searchCustomers`/`getCustomer`/`createCustomer` plus a new `CustomerRepository` in `core-sync` — every call reaches the network, with no local fallback; a register with no signal simply cannot attach a customer that moment, but the sale rings up fine without one either way.
- `RegisterViewModel.searchCustomers`/`attachCustomer`/`detachCustomer`/`createCustomer`, and a new `CustomerDialog`: one search field classifies its own input (phone-shaped digits vs. a name/email fragment) rather than asking the cashier to pick a mode. The existing "Walk-in customer" subtitle in `CartPanel` became the entry point — made clickable in place, rather than adding a new control, since the compact register layout has no vertical room to spare for one.
- A resumed held sale re-resolves the customer's name from its id with a best-effort lookup, since the id survives a hold (it is a plain field on the cart) but a name never does — nothing is ever cached.
- The receipt now names the attached customer, by name only — never a phone or email, the same restraint the schema itself uses.
- `CustomerDialog`'s own content column needed `verticalScroll`: Material3's `AlertDialog` clips overflow rather than scrolling it, and this dialog's four-field creation form did not fit the primary target device's short landscape screen. Third time this exact failure mode has shown up this phase (`CartPanel`'s header, `SplitPaymentDialog`'s keypad, now this) — worth treating as a standing risk on every new dialog aimed at this device rather than a one-off.

Verified end to end on the physical target device signed in as a seeded cashier: searching by name and by phone both find a customer already known to the server; attaching one updates the header and prints on the receipt; a held sale resumed later re-shows the same name; a cashier without `customer.manage` is refused when creating a new customer, with the refusal visible on screen, not just in a log.

## Phase 2 — Manager-authorized price override

Wired up `Cart.overridePrice`, which had existed in the domain layer with no
caller. Unlike a line discount, a cashier does not hold `sale.price_override`
by default, so this always goes through the same manager PIN prompt as a
refund or a void -- never a plain permission check on the signed-in cashier,
which would defeat the point of the permission existing.

- `RegisterViewModel.requestPriceOverride` stores the pending line, new price
  and reason and raises the same `ApprovalDialog` refunds and voids use, now
  also mounted at the selling stage rather than only inside the refund flow.
- On approval, `shift.approve("sale.price_override", pin)` names the manager;
  `Cart.overridePrice` re-runs `CartLine`'s own invariants on `copy()`, so a
  negative price is refused by the domain regardless of what the dialog let
  through -- checked twice, not trusted once.
- Added the missing negative-price-override test alongside the existing
  positive-path coverage: a price override cannot make a line negative, and a
  price of exactly zero is accepted as a legitimate discretionary give-away.

Not yet verified on hardware -- no device was connected while this was built.

## Phase 2 — Modern register workspace

- Reworked the Android register into a high-contrast, touch-first workspace with a persistent operational header, prominent scanner/search field, category rail, product cards, current-sale context, and responsive cart.
- Added a real permission-checked line-discount flow with bounded amounts, required reason codes, domain invariants, and automated over-discount coverage.
- Added selected-line actions, cart clearing with confirmation, clearer empty-cart guidance, receipt/return/shift shortcuts, and compact quantity controls.
- On short landscape devices, age verification becomes the blocking primary action so the cart line, totals, and compliance requirement remain visible together.
- Redesigned employee unlock with profile cards, secure PIN panel, clear register readiness state, and a fully visible landscape keypad.
- Added `docs/POS_DESIGN_SYSTEM.md` to keep future POS screens consistent and prevent non-functional controls from entering the cashier workflow.

### Fixed

- **The unlock PIN pad's backspace key was unreachable.** Its icon rendered as a sibling of the clickable box rather than inside it, so the visible glyph sat outside the tappable region and had no click handler of its own -- tapping it did nothing, and the actual clickable area was a blank square to its left. Caught by reading the layout rather than trusting that it compiled; moved the icon into the same `Box` as the other keys, matching the working pattern in `DrawerScreen.SimpleKeypad`. Not yet re-verified on hardware -- no device was connected when this was found.

## Phase 2 — Atomic incremental catalog projections

- `GET /v1/sync/catalog` now accepts the register's last cursor and returns only
  affected projections through `included_scopes`. A price-only edit no longer
  retransfers products, barcodes, inventory, or the employee roster.
- Change detection, projection reads, and cursor selection share one PostgreSQL
  transaction, closing the cross-scope race created by separate check/fetch
  requests.
- Android replaces only named Room projections and advances its cursor in the
  same local transaction. Deletions are reconciled by absence, and a crash
  cannot leave a new cursor over old data.
- A cursor ahead of a restored server forces a complete bootstrap. Unknown
  projection scopes fall back to the complete snapshot.
- End-to-end coverage proves unchanged pulls transfer nothing, price-only pulls
  remain price-only, cursors stay stable, and reset recovery bootstraps.

## Phase 2 — One pricing specification, two engines

The backend and offline register must calculate identical amounts even though
one is TypeScript and the other Kotlin. A language-neutral fixture suite now
makes that agreement a required CI property instead of an architectural promise.

### Added

- **51 shared pricing cases** covering half-up rounding, negative sale/refund
  amounts, exact allocation, deterministic remainder placement, weighted
  allocation and six-decimal catalog costs. Every value is encoded as a string
  so the specification never depends on a language's JSON-number behavior.
- **Two independent runners.** Node executes the TypeScript money engine and a
  pure JVM test executes Kotlin against the same four JSON files. CI runs both
  in one `Pricing conformance (both engines)` job on every commit.
- **Vacuous-pass guards and mutation proof.** Missing fixtures, empty files and
  an unexpectedly small case set fail. Removing Kotlin half-up rounding was
  verified to fail on the exact named fixture that distinguishes it from
  truncation.

### Fixed

- Kotlin rate and weighted-allocation intermediates now use `BigInteger` before
  converting the final posted amount back to `Long`. A valid final amount can
  otherwise overflow an intermediate multiplication and fail only on one side
  of synchronization.
- Both cost parsers now enforce PostgreSQL's `numeric(14,6)` fractional scale
  instead of accepting precision the database cannot preserve.
- Kotlin money formatting now handles `Long.MIN_VALUE`; negating that value in
  `Long` overflows back to itself.

## Phase 2 — The incremental change feed, populated

`change_log`, its cursor index, `sync_changes_watermark()` and
`GET /v1/sync/changes` all existed. **Nothing ever wrote a row**, so the feed was
a skeleton: a register asking what changed was always told "nothing", and the
only way to learn about a price change was to pull the whole catalog again.

### Added

- **Migration 0008** — one parameterised `log_change()` trigger function and
  twelve triggers, on the tables a register actually replicates. One function
  rather than twelve near-identical ones, because those drift, and the way they
  drift is that one quietly stops logging and a till stops hearing about a
  category nobody can explain.
- **Ignored columns.** `updated_at` is stripped on every table, because a
  `_touch` trigger bumps it on every update — leaving it in means no two
  versions of a row ever compare equal, the suppression never fires, and the
  hash changes when the content did not. `users.last_login_at` is stripped too:
  every sign-in writes it, so without this every sign-in marked the whole
  `employees` scope dirty for every register in the store. A false positive on
  the most frequent write in the system, on the very feed that exists to avoid
  pointless refetching.
- **`inventory_levels` is deliberately not tracked.** It changes on every line
  of every sale at every register, so the feed would be almost entirely
  inventory churn — and the register treats stock as advisory, shown so a
  cashier can answer "have we got more", explicitly not gating a sale. Stock
  arrives with the bootstrap snapshot instead.

- **The register asks before it pulls.** `CatalogSync` now calls the feed with
  `limit=1` and returns immediately when nothing changed, transferring nothing.
  A failed feed read falls through to a full pull rather than concluding the
  catalog is current. Incremental *detection*, not yet incremental
  *application*: when something has changed the register still pulls the whole
  snapshot, because per-entity fetching needs endpoints that return a row in the
  register's projection shape and those do not exist. Verified on a Galaxy S22
  Ultra across both branches and back to idle.

### Fixed

- **The change feed returned its pages in the wrong order.** The query was
  `SELECT id::text ... ORDER BY id`, and a bare `ORDER BY id` binds to the
  *output* column — the text cast — ahead of the table's bigint. So the cursor
  sorted lexicographically: 1, 10, 11, … 19, 2, 20. With a `LIMIT` that returns
  an arbitrary subset, and a register paging with `since` would skip changes
  **permanently** — a price change or a new product that no till ever hears
  about, with nothing anywhere reporting a fault. Exactly the class of silent
  loss the watermark exists to prevent, reintroduced one line below it.
  `ORDER BY change_log.id` cannot bind to an output alias.

  This was invisible while `change_log` was empty, and surfaced the moment the
  triggers gave it more than nine rows to order.

## Phase 2 — Upload the moment the network returns

### Added

- **`ConnectivityWatcher`** — a default-network callback that calls `syncNow`
  when the network becomes usable. `VALIDATED`, not merely connected: a register
  walking back into range is associated-but-unproven for a second or two, and
  uploading into that state burns a retry. Only a transition into usable fires
  it, because wifi-to-mobile handover and radio re-association produce callbacks
  while the register was online throughout.

  It exists because **a satisfied constraint does not shorten a backoff**.
  WorkManager releases constraint-blocked work as soon as connectivity returns,
  so a register that was merely offline would have coped; a worker that already
  failed and was rescheduled carries a timing delay that connectivity does not
  clear, and `syncNow`'s `REPLACE` cancels it.

  It does **not** cover a healthy network with a dead server — nothing changes
  from Android's point of view, so no callback fires. That falls to the next
  sale or the periodic job, and closing it would mean polling a server that is
  already failing to answer.

  Verified on a Galaxy S22 Ultra: airplane mode on, sale queued, airplane mode
  off, and the log reads `network usable again; draining the outbox` followed by
  `upload: 1 accepted, 0 duplicate, 0 rejected, 0 dead, 0 left` — on the server
  within twelve seconds, landing exactly once, ledger in agreement, no dead
  letters.

## Phase 2 — Receipts

A receipt is described, not formatted: `ReceiptRenderer` produces an abstract
`ReceiptDocument` and whatever consumes it decides the width. The same document
prints to 58mm, to 80mm, and to the screen, which is what stops a preview
drifting from the paper a customer is holding. 14 tests, all pure Kotlin.

### Added

- **`ReceiptDocument`** — text, label/amount rows, sold items, separators and a
  machine readable receipt number. No column widths, no printer commands.
- **`TextReceipt`** — the rasterizer. Paper width is a value (`Mm58` = 32
  columns, `Mm80` = 48), not a second template. Amounts are flush to the last
  column so a receipt can be checked by running a finger down the right edge,
  long product names wrap on word boundaries, and a label that would crowd the
  amount is truncated rather than wrapped — the amount is the part that has to
  survive.
- **`PrinterProvider`** in `hardware-api`, interfaces only. Every method
  reports rather than throws: the money has changed hands by the time a receipt
  is produced, so a printer out of paper must never be able to fail a sale.
- **The receipt on screen**, rendered through the same `TextReceipt` a printer
  would use, reachable from the register once there is a sale to show. It says
  "No printer configured" plainly — a Print button that silently does nothing
  is worse than no button, because a cashier presses it and hands the customer
  nothing.

### Compliance

An age restricted sale records **that the check happened** — "Age 21+ ID
verified" — and nothing else. No date of birth, no licence number, no name. A
receipt ends up in a bin behind the counter, and identity data on it is a breach
made of paper. There is a test asserting the rendered receipt contains none of
those words.

### Not built

The ESC/POS driver. There is no printer here to verify one against, and an
unverifiable driver that looks finished is worse than an absent one. The
interface it plugs into is done and the document it consumes is tested.

Store address, phone and return policy are shop configuration that does not
exist yet, so the receipt omits them rather than inventing them.

## Phase 2 — A scan could be silently dropped

### Fixed

- **Scanning fast lost items from the cart.** Measured on a Galaxy S22 Ultra:
  10 scans at 2.5s intervals added 10 items, but 10 scans back to back added
  **7**, and the same barcodes delivered as raw key events added **2**. A
  customer charged for one of the two things in their hand, on the one code path
  a shop uses thousands of times a day.

  The cause is a lost update that reads as atomic and is not:

  ```kotlin
  _state.value = _state.value.copy(tiles = catalog.byCategory(...))
  ```

  Kotlin evaluates the receiver first, then suspends on the Room query, then
  copies the state it captured *before* the suspension. Anything written while
  it was suspended is discarded. Clearing the scan field calls this on every
  submit, so two scans in quick succession overlapped: the search started by the
  first read the cart, suspended, and wrote the pre-scan cart back over the item
  the second had just added.

  Both occurrences now resolve the query into a local before touching state.
  Re-measured on the same device at the same speed: **10 of 10 and 20 of 20**,
  no loss on either input path.

  Worth stating plainly: this never reproduced while driving the register by
  hand, because a person cannot scan fast enough to overlap two database reads.
  It only appeared under machine-speed input, and it is exactly the kind of
  defect that survives to production as "the count is off again".

## Phase 2 — Voids through sync

A void composed at the counter, authorised by a manager PIN, delivered through
the sync batch under the cashier's token. 93 end to end checks pass.

Verified on a Galaxy S22 Ultra: the 2 to 3 migration against existing data, the
cashier's PIN refused, a manager's accepted, and the void landing server side
with stock restored, the ledger agreeing and the drawer netted to zero.

### Added

- **`sale_void` as a sync entity.** A void is its own entity rather than a
  mutation of the sale it voids: sales are append only on both sides, and an
  upload that edited a row already delivered would have no idempotency key of
  its own to make the retry safe. Authority is the approver's, exactly as for a
  refund.
- **`SalesService.intakeVoid`** — idempotent on the sale's own status, so a
  redelivery reports `duplicate` and nothing is restocked twice. `voidInTx` is
  shared with the HTTP route so both reverse stock through the same code; two
  implementations of "put the sale's stock back" would drift, and the direction
  they drift in is a count that is quietly wrong.
- **Room schema 3 and `MIGRATION_2_3`** — `voidedAtMillis`, `voidedBy` and
  `voidReason` on `sales`. Nullable rather than defaulted: a default would claim
  every historical sale had been voided by nobody at the epoch.
- **`VoidRepository`** — the same two guards as the server, checked before
  anything is written so a refusal leaves no trace, plus the drawer reversal.
  The void action is offered only while the whole sale is still returnable.
- **A voided receipt says so.** Looking one up for a refund used to answer "no
  sale on this register with receipt HH01-R1-7", which is untrue — the sale is
  there, it was voided — and sends a cashier looking for a receipt they are
  holding.
- **`RetryableIntakeError`** — a void whose sale has not arrived yet waits
  instead of being rejected. Entities are ordered inside a batch but not across
  batches, so a sale whose upload failed while its void succeeded is a normal
  sequence. Rejecting would dead letter the void after five attempts and leave a
  sale standing that a manager already voided at the counter.

### Fixed

- **Voiding a cash sale left the money in the drawer.** The void reversed stock
  but never the tender, so the drawer was expected to hold cash that had been
  handed back — every voided cash sale read **over** by its own amount at close.
  That is worse than a missing feature: over and short are the only signal a
  manager has, and a cashier who voided a sale and pocketed the notes produced a
  drawer that balanced perfectly. Captured cash now reverses into the same
  session, under an id derived from the payment being reversed so a replayed
  void cannot take it out twice. Only cash reverses — a card void has to go back
  through the processor, and no provider is integrated yet. A void of a sale
  from a closed shift is refused, with the remedy named: refund it, so the money
  leaves today's drawer.

## Phase 2 — Refunds on the device

A partial refund against a receipt, approved by a manager PIN on the register,
uploading and restocking server side. Verified on a Galaxy S22 Ultra. 83 end to
end checks pass.

### Added

- **Room schema v2 and `MIGRATION_1_2`** — `refunds`, `refund_lines`, and
  `quantityRefunded` on `sale_lines`. Hand written and exercised against a
  device that already held v1 data. `fallbackToDestructiveMigration` stays off:
  on a register, dropping the database to resolve a version mismatch deletes
  completed sales that have not uploaded yet.
- **`RefundRepository`, `RefundsDao`, `RefundScreen`, `ApprovalDialog`** — the
  on device flow. Over-refund is refused before anything is written, so a
  refusal leaves no trace. Tax is divided back out per unit so a partial refund
  returns a proportional share.
- **Delegated approval on the sync route** — `APPROVER_FIELD_BY_ENTITY`. A
  refund's authority comes from the user its payload names in `approved_by`,
  looked up live and required to be active and to hold `refund.create`.

### Fixed

- **A manager approved refund could never upload.** The register uploads under
  the cashier's token and a cashier does not hold `refund.create`, so every
  refund taken at the counter would have been rejected as non-retryable and
  dead lettered. Checking the uploader's permissions is wrong for an action
  someone else authorised; checking the named approver's is both correct and
  stricter, because the device's claim about who approved is now verified
  rather than trusted. A register naming the cashier themselves is refused
  exactly like one naming nobody.
- **The approval button was off screen.** The refund's right hand column was a
  fixed `Column` taller than the ~384dp a phone has in landscape, so the button
  was clipped and the refund could not be completed on the only form factor the
  register runs on. The reason list scrolls; the amount and the button are
  pinned.
- **`syncNow` used `APPEND_OR_REPLACE`,** chaining each sale behind the one
  before it. A single entity in exponential backoff then held up every sale rung
  after it — head of line blocking on the one path that must never stall.
  `REPLACE` loses nothing, because the worker drains the whole outbox rather
  than one entity, and it clears a stuck backoff the moment the next sale is
  rung.
- **The end to end suite reset the development database.** It drops and
  recreates whatever it points at, and pointed at `snappos` it also wiped the
  registers a physical device was provisioned against — leaving that device with
  queued sales referencing store, register and variant ids that no longer
  existed and no way back. It now uses `snappos_e2e`.
- **The approval dialog showed a stale refusal** while the next PIN was being
  typed, and the keypad shifted under the manager's finger as the message
  appeared and went. The message clears on the first digit and its slot is a
  fixed height. Reserving that height cost the dialog its bottom keypad row on
  a phone in landscape — taking backspace and clear with it, so a mistyped
  digit could only be resolved by submitting it and failing — so the dialog's
  padding came down to pay for it.
- **The bootstrap snapshot answered a bad request with an empty catalog.**
  `GET /v1/sync/catalog` took `store_id` as an unvalidated query parameter, so
  omitting it — or naming a store in another organization, which RLS makes
  invisible — returned **200** with no staff, no prices and no stock. A
  register cannot tell that apart from a store that genuinely has none: it
  shows "no staff on this register yet", cannot be unlocked, and nothing
  anywhere says why. `store_id` is now required and the store must exist in the
  caller's organization; otherwise 400 or 404.
- **An empty roster gave a guess instead of a reason.** "No staff on this
  register yet. Connect to the server to set it up." reads as a diagnosis but
  was really the most likely of four different situations, and the advice is
  wrong for three of them. The unlock screen now distinguishes not provisioned,
  never synced, synced-but-the-server-named-nobody, and every-employee-inactive,
  from durable state — the catalog cursor and a count of employee rows
  regardless of status. A till that will not open is the worst failure this
  product has, and whoever is standing at it has to be able to say something
  useful down the phone.

### Known limits

- Receipt lookup is local to the register that rang the sale.
- The refund tender is always cash. A card refund has to go back to the card,
  and no payment provider is integrated yet.

## Phase 1 — API vertical slice

Auth, tenancy, RBAC, idempotency, catalog, inventory and sync, working end to end
against real Postgres. 34 end to end checks pass.

### Added

- **`apps/api`** — NestJS on Fastify. Platform layer (database, auth, RBAC,
  idempotency, errors, validation) plus catalog, inventory, sync and org modules.
- **`packages/contracts`** — Zod schemas as the single source of truth, with the
  `Money` type. 24 tests.
- **Migration 0006** — `product.view`, `sync.upload`, `sync.download`.
- **Migration 0007** — `auth_lookup_user` and `auth_lookup_session`.
- **`InventoryRepository`** — the only code permitted to write `inventory_levels`,
  always in the same transaction as a ledger entry. `reconcile()` proves the
  projection still equals `sum(delta)`.
- **End to end suite** — resets the database, starts the API, exercises the real
  HTTP surface.

### Fixed

- **Login could not work under RLS.** The policy denies when `app.org_id` is
  unset, and the organization is unknown until the user is found. Resolved with
  two narrow `SECURITY DEFINER` lookups (migration 0007) rather than by weakening
  the policy or connecting as a role that bypasses RLS. Fixed column lists,
  `search_path` pinned, `EXECUTE` revoked from `PUBLIC`.
- **Every validation failure returned 500.** The API compiles to CommonJS and
  `@snappos/contracts` is ESM, so each half loads a different copy of zod and
  `instanceof ZodError` is false across that boundary, despite npm installing
  exactly one version. The validation pipe now converts at the boundary and the
  filter duck types as a fallback.
- **Deterministic ledger ids did not actually prevent double counting.**
  `inventory_ledger` is partitioned by month, so its key is `(id, occurred_at)`
  and not `id` alone. A replay reusing the id while letting `occurred_at` default
  to `now()` inserted a second row while appearing protected. The repository now
  refuses a deterministic id without a deterministic timestamp, and the sync path
  derives the timestamp from the UUIDv7's own embedded clock so the two cannot
  disagree.
- **The seed was not re-runnable.** It deleted the organization, which
  `ON DELETE RESTRICT` correctly forbids once stores exist. It now clears its own
  tables in dependency order. The earlier "idempotent" check had passed against a
  state that did not exercise the constraint.

### Security

- The API refuses to start if it detects a database role that owns tables, is a
  superuser, or has `BYPASSRLS`.
- Refresh token rotation with family revocation on reuse.
- Argon2id for passwords; cheaper parameters plus lockout for register PINs.
- Constant time response for unknown accounts at login.
- Upgraded NestJS to 12 and drizzle-orm to 0.45.2, clearing a high severity SQL
  injection advisory (GHSA-gpj5-g38j-94v9) and two fastify advisories.

### Documentation

`SECURITY.md`, `DATABASE.md`, `API.md`, `MONEY.md`, `COMPLIANCE.md`,
`INTEGRATIONS.md`, `DEPLOYMENT.md`, `TESTING.md`.

---

## Phase 0 — Repository foundation

The architecture and migrations existed; the repository did not. Nine files sat
flat in the project root while the README and the invariant test referenced a
layout that had never been created.

### Added

- npm workspaces monorepo (npm rather than pnpm and Turborepo: it ships with
  Node and needs no install step on a new machine).
- Migration runner with checksum tracking, so editing an applied migration is a
  hard error rather than a silent divergence.
- `bootstrap-roles.sql` — the `snappos_migrator` / `snappos_app` split. **Nothing
  previously created these roles**, which meant RLS had never been exercised
  against a non-owner.
- RLS test suite, 9 tests, connecting as the unprivileged role.
- Dual engine testing: every suite runs on PGlite and on real PostgreSQL 16.
- Seed with a realistic catalog — six products, twelve variants, one deliberately
  out of stock. Opening stock posts through the ledger.
- CI: PGlite as the fast gate, PostgreSQL as the authoritative one.

### Fixed

- The README's "26 passing tests" **could not be reproduced by anyone**: no
  `package.json`, no PGlite dependency, no `migrate.test.mjs`. All 26 now pass on
  both engines.
- The claimed "78 check constraints" was partition inclusive and therefore date
  dependent — `ensure_monthly_partitions()` creates partitions relative to
  `now()`, and it had already drifted to 76. Tests now assert only counts that
  are stable facts about the migrations.
- PostgreSQL test files run serially. Each bootstraps roles and grants, which
  write cluster wide catalogs, and running them in parallel produced
  `tuple concurrently updated` at random points.

---

## Prior work

Architecture (`docs/ARCHITECTURE.md`, sections A–O) and the Phase 1 schema:
63 tables, 93 foreign keys, 20 enums, RLS policies, append only triggers,
monthly partitioning, UUIDv7 generation.
