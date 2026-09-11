# Database

PostgreSQL 16. Hand written SQL migrations in `packages/db/migrations/`, applied
in numeric order and tracked by checksum.

Current shape, asserted by `packages/db/test/migrate.test.mjs` rather than counted
by hand: **63 base tables**, 93 foreign keys, 62 table level checks, 20 enums, 9
functions, 18 triggers, RLS on all 60 tenant tables.

## Six rules the schema obeys

**1. Every tenant table carries `org_id`**, and child tables use composite foreign
keys `(id, org_id)` so a row physically cannot reference a parent in another
organization. RLS sits on top as defence in depth. See [SECURITY.md](SECURITY.md).

**2. Primary keys are UUIDv7**, from `uuid_generate_v7()`. Time ordered, so index
locality is good, unlike v4. Critically, a register can generate them offline and
the server accepts them as given.

The implementation steps a session-scoped counter when the clock does not advance
or moves backwards, because Android's clock has millisecond resolution and a
register can mint several ids inside one millisecond. Without that, ids within a
millisecond are unordered and the locality benefit is lost.

**3. Financial and inventory history is append only.** Sales, payments, refunds
and stock movements are never updated in place. A void is a new record. A
correction is a new record. Enforced by triggers (`guard_sale_immutable`,
`guard_no_delete`), not by convention.

**4. Everything sellable is a variant.** A product with no flavors still has
exactly one variant row. This removes an enormous amount of branching in pricing,
inventory, barcodes and reporting. Barcodes, cost, price and stock live on the
variant, never on the product.

**5. Compliance rules are data with effective dates**, never code. The engine
fails closed: if eligibility cannot be established, the transaction is not
allowed.

**6. High volume history is partitioned monthly from day one** — `inventory_ledger`
and `audit_log`. Retrofitting partitioning onto a live 60 million row audit table
is a weekend nobody enjoys.

## Tables that deserve specific comment

### `inventory_ledger`

The truth about stock. `inventory_levels` is a projection of it, and a
reconciliation job proves the two still agree.

Partitioned by month, so its primary key is **`(id, occurred_at)`** and not `id`
alone — a partitioned table's key must include the partition column.

That has a consequence which is easy to miss and expensive: a replay that reuses
the id but lets `occurred_at` default to `now()` **does not conflict**. It inserts
a second row and double counts, while looking like it is protected by a
deterministic id. Any caller supplying a deterministic id must supply a
deterministic timestamp with it, from the source document. The sync path derives
it from the UUIDv7's own embedded timestamp, so the id and the time cannot
disagree, and `InventoryRepository.post()` refuses the unsafe combination.

`ledger_delta_nonzero` rejects a zero movement: nothing moved is not a fact worth
recording. A variant stocked but empty gets a level row at zero and no ledger
entry — the difference between "we stock this and have none" and "we do not stock
this".

### `inventory_levels`

`available` is `GENERATED ALWAYS AS (on_hand - reserved)`. It cannot be set by
hand.

Two asymmetries that look like bugs and are not:

- **`on_hand` MAY go negative.** Two registers offline at once can both sell the
  last unit. Both sales are facts; the customers already left with the product.
  Refusing the second record would not un-sell it, only hide the discrepancy.
- **`reserved` may NOT go negative.** A reservation is created by this system, so
  a negative one is always a bug here, never a fact about a shelf.

### `change_log`

The backbone of downstream sync. A `bigserial` cursor plus `payload_hash` rather
than the payload: the table stays small on a counter that writes constantly, and
a replicated table can be reshaped without rewriting history.

`sync_changes_watermark()` returns the highest id safe to hand out. A bigserial is
allocated before its transaction commits, so consuming up to `max(id)` skips rows
permanently.

### `idempotency_keys`

`(org_id, key, request_hash, state, response_status, response_body)`, unique on
`(org_id, key)`. The `in_flight` state is what makes concurrent duplicate delivery
safe: without it, two deliveries of one request both find nothing and both
execute.

### `audit_log`

Partitioned monthly, hash chained per organization. A broken chain means someone
edited history directly in the database.

### `categories`

Materialized path (`vapes.disposable.geek-bar`), deliberately **not** `ltree`: no
extension dependency, and the path is readable in any client. Path and depth are
maintained by the application.

### `auth_sessions`

Refresh token families. `family_id`, `rotated_at`, `revoked_at`. Only a SHA-256
hash of the token is stored.

## Extensions

Exactly one: `pg_trgm`, for fuzzy product search. Migration `0002` wraps it in a
`DO` block that degrades to `tsvector` only if the extension is unavailable,
because some managed hosts require allowlisting first. PGlite does not bundle it,
so the test skips there with a notice and asserts the real index on Postgres.

## Roles

| Role | Owns tables | Bypasses RLS | Used by |
|---|---|---|---|
| `snappos_migrator` | yes | yes, by ownership | migrations, seeds, backfills |
| `snappos_app` | no | no | the API, always |

Created by `packages/db/scripts/bootstrap-roles.sql`. Nothing in the original
migrations created these, which meant RLS had never actually been exercised
against a non-owner until they existed.

## Working with it

```bash
npm run db:up        # Postgres 16, Redis, MinIO, Toxiproxy
npm run db:reset     # drop, create, bootstrap roles, migrate, seed
npm run db:migrate   # apply pending migrations only
npm run db:seed      # re-seed (idempotent; refuses if the database holds sales)
```

**Never edit an applied migration.** `migrate.mjs` stores a checksum and stops
with an error if a file that already ran has changed, because at that point the
repository and the database disagree about what the schema is. Write a new
migration.

The seed clears its own tables in dependency order rather than deleting the
organization: almost every foreign key to `organizations` is `ON DELETE RESTRICT`,
on purpose, so nobody can remove a business and take its financial history with
it.
