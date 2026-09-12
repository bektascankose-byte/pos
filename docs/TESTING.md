# Testing

## What exists today

| Suite | File | Tests | Engine |
|---|---|---|---|
| Migration shape | `packages/db/test/migrate.test.mjs` | 9 | both |
| Schema invariants | `packages/db/test/invariants.test.mjs` | 26 | both |
| Row level security | `packages/db/test/rls.test.mjs` | 9 | PostgreSQL only |
| Money and schemas | `packages/contracts/src/{money,schemas}.test.ts` | 24 | n/a |
| Pricing conformance | `packages/pricing-spec/fixtures/*.json` | 51 cases | TypeScript + Kotlin |
| End to end HTTP | `apps/api/scripts/e2e.mjs` | 83 | PostgreSQL only |

44 on PostgreSQL. 34 plus 2 skipped on PGlite.

```bash
npm test                          # PGlite
npm test -w @snappos/pricing-spec # TypeScript side of shared pricing fixtures
npm run test:pg -w @snappos/db    # PostgreSQL, needs npm run db:up first
npm run e2e                       # end to end, needs npm run db:up first
cd apps/pos-android && ./gradlew :core-domain:test # Kotlin side
```

## Pricing must agree offline and online

The TypeScript backend and Kotlin register execute the same 51 language-neutral
JSON cases from `packages/pricing-spec/fixtures`. Neither implementation is the
reference; the fixtures are. They pin rounding, negative amounts, proportional
allocation, tie-breaking and six-decimal catalog-cost posting. CI runs both
engines on every commit in one required job.

The Kotlin runner refuses to pass when it finds no files, no cases, or fewer
than 40 cases. The suite was also mutation-tested by removing half-up rounding:
it failed on the named half-cent fixture, proving that this gate detects a real
pricing disagreement rather than only proving that both runners start.

## The end to end suite has its own database

`npm run e2e` **drops and recreates** the database it points at, so it points at
`snappos_e2e` and never at `snappos`. This matters more than it looks: a
physical register is provisioned against `snappos`, and resetting it out from
under the device leaves that device holding queued sales that reference store,
register and variant ids which no longer exist, an empty roster, and no way
back. The register cannot be signed into and its unuploaded sales cannot be
recovered. Running the tests must never cost somebody their till.

Override with `E2E_DB_NAME`, or `E2E_MIGRATOR_URL` and `E2E_DATABASE_URL` for
the two roles. `E2E_SKIP_RESET=true` reuses whatever is already there.

It builds to its own output directory too, `dist-e2e`, for the same reason.
`nest build` empties its target first, so building into `dist` while a
`nest start --watch` dev server is running from it kills that server — the file
it is about to reload disappears mid-rebuild, and the failure surfaces much
later as a device that cannot reach the API for no visible reason.

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

- Offline sync harness driving the register through Toxiproxy: dropped, delayed, duplicated and
  reordered requests (Phase 2, §M risk 4)
- Instrumented Android tests: the Room migrations currently have no automated
  coverage and are proven by installing over a device that holds the old
  version, which does not run in CI
- The `change_log` bigserial gap test, which forces interleaved commits (§E)
