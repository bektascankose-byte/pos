# Changelog

Notable changes. Newest first.

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
