# Testing

## What exists today

| Suite | File | Tests | Engine |
|---|---|---|---|
| Migration shape | `packages/db/test/migrate.test.mjs` | 9 | both |
| Schema invariants | `packages/db/test/invariants.test.mjs` | 26 | both |
| Row level security | `packages/db/test/rls.test.mjs` | 9 | PostgreSQL only |

44 on PostgreSQL. 34 plus 2 skipped on PGlite.

```bash
npm test                          # PGlite
npm run test:pg -w @snappos/db    # PostgreSQL, needs npm run db:up first
```

## The two engine rule

Migrations must apply to both PGlite and PostgreSQL 16, and CI runs both. PGlite is the fast gate;
PostgreSQL is the authoritative one.

The difference is not performance, it is capability. **Row level security does not apply to a table
owner.** PGlite exposes one superuser and cannot create a second login role, so every RLS policy is
invisible there. A suite that ran only on PGlite would report tenancy as working while testing
nothing at all. `rls.test.mjs` therefore connects as `snappos_app` and skips loudly under PGlite
rather than passing.

Known engine differences are asserted, not tolerated in silence:

- `pg_trgm` is absent from PGlite. Migration `0002` degrades to `tsvector` only rather than failing,
  which is also correct for managed hosts that require extension allowlisting. The test skips with a
  notice on PGlite and asserts both the extension and `variant_search_trgm_idx` on PostgreSQL.

## Writing a schema test

Use `createScratchDatabase()` from `packages/db/src/engine.mjs`. On PGlite it is a fresh in memory
instance; on PostgreSQL it is a real `CREATE DATABASE`, dropped afterwards, so a test run never
touches development data. Databases orphaned by a crashed run are swept on the next run.

Teardown belongs in node:test's `after()` hook. A bare `await scratch.drop()` at the end of the file
runs before the tests do, because `test()` registers rather than executes.

## Why PostgreSQL tests run serially

Each PostgreSQL test file bootstraps roles and grants, and `CREATE ROLE`, `ALTER ROLE` and
`GRANT ... ON DATABASE` write cluster wide catalogs. Running the files in parallel produces
`tuple concurrently updated` at random points, which looks like flakiness and is not. The runner
passes `--test-concurrency=1` for PostgreSQL. PGlite instances are isolated and stay parallel.

## What counts as asserted

The object counts in the README are assertions in `migrate.test.mjs`, so the documentation cannot
drift from the schema without CI failing.

Counts that include partitions are deliberately not asserted. `ensure_monthly_partitions()` creates
partitions relative to `now()`, so any total that includes them changes with the calendar. An
earlier revision of the README quoted a partition inclusive check constraint count and it had
already drifted by two before anyone ran it.

## Still to build

Per the architecture, in the phase that introduces each:

- Pricing conformance suite across the TypeScript and Kotlin engines (Phase 2, §B)
- Offline sync harness driving the register through Toxiproxy: dropped, delayed, duplicated and
  reordered requests (Phase 2, §M risk 4)
- API integration tests, permission tests, refund and inventory tests (Phase 1 onward)
- The `change_log` bigserial gap test, which forces interleaved commits (§E)
