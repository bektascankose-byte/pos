# SnapPOS

A cloud backed, offline first retail point of sale platform for age restricted retail: smoke shops, vape shops, tobacco stores and convenience retail.

Working codename. Rename before commercialization.

## Where the project stands

| | Status |
|---|---|
| Architecture | Decided. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). |
| Phase 0 monorepo | **Built.** npm workspaces, CI, dev stack, migration runner, seed. |
| Phase 1 database schema | **Written and executed on PostgreSQL 16 and PGlite.** 63 tables, 93 foreign keys, 62 table level checks, 20 enums, 7 functions, 18 triggers, RLS on all 60 tenant tables. |
| Schema, invariant and RLS suites | **44 passing on PostgreSQL**, 34 passing + 2 skipped on PGlite. |
| Phase 1 API | **Built and exercised over HTTP.** Auth, tenancy, RBAC, idempotency, catalog, inventory, sync, sales and refunds. 83 end to end checks. |
| Android register | **Selling on hardware.** Offline sales, cash drawer and shift close, PIN unlock, and refunds with manager approval, verified on a Galaxy S22 Ultra. See [`docs/ANDROID.md`](docs/ANDROID.md). |
| Dashboard, storefront | Not started. |

The schema numbers above are asserted by a test, not counted by hand:
`test/migrate.test.mjs` fails if the schema stops matching them. The suite
totals are what the suites themselves report.

## Start here

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the plan. Sections E (offline sync), F (inventory) and I (compliance) are the ones that determine whether this product works.
2. [`packages/db/migrations/`](packages/db/migrations/) is the schema, in dependency order.
3. [`packages/db/test/`](packages/db/test/) is executable documentation of what the schema guarantees.

## Running it

```bash
npm install
npm run db:up        # Postgres 16, Redis 7, MinIO, Toxiproxy
npm run db:reset     # drop, create, bootstrap roles, migrate, seed
```

Then the suites:

```bash
npm test                      # PGlite. No daemon, about two seconds.
npm run test:pg -w @snappos/db   # real Postgres, including RLS
```

### Why two database engines

PGlite is Postgres compiled to WebAssembly. It runs the real migrations with no Docker and no
daemon, which makes it the right default for a fast edit-run loop and for the quick CI gate.

It cannot, however, prove tenancy. **Row level security is a no-op for the table owner**, and PGlite
has a single superuser with no way to create a second login role. A policy suite run there would
pass without testing anything. So the RLS suite connects to real Postgres as `snappos_app` — a
non-owner with no `BYPASSRLS` — and proves that an unset org context returns zero rows rather than
leaking. Both engines run in CI and a change must pass both.

Two known differences, both reported rather than hidden:

- `pg_trgm` is not bundled with PGlite, so fuzzy product search degrades to `tsvector` there. The
  migration degrades deliberately rather than failing; the test skips with a notice and asserts the
  real index on Postgres.
- The RLS suite skips entirely on PGlite, loudly, for the reason above.

## Local development

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d
```

Postgres 16, Redis 7, MinIO and Toxiproxy. Toxiproxy is there for the Phase 2 offline sync harness,
which drops, delays, duplicates and reorders requests.

The database uses two roles and the split is the point:

| Role | Owns tables | Bypasses RLS | Used by |
|---|---|---|---|
| `snappos_migrator` | yes | yes, by ownership | migrations, seeds, backfills |
| `snappos_app` | no | no | the API, always |

If the API is ever pointed at `snappos_migrator`, every policy in `0005_rls.sql` silently stops
applying. `test/rls.test.mjs` asserts the app role is not an owner for exactly this reason.

## Three things to start outside the codebase, today

These have lead times measured in weeks and they sit on the critical path. None of them are engineering work.

1. **Apply for a high risk merchant account.** Stripe, Square and PayPal all prohibit vape and nicotine. You need an account underwritten for MCC 5993 behind a gateway such as NMI, Authorize.Net, USAePay or PayTrace. Phase 3 cannot be tested without sandbox access, and sandbox access generally follows approval.
2. **Book a compliance review with an attorney**, covering the current status of your hemp categories, delivery sales under the PACT Act and the Texas e-cigarette retailer permit, and what verification records you are permitted to retain. Federal H.R. 5371 redefines hemp effective 2026-11-12.
3. **Pull a full Modisoft export now** and keep pulling one monthly. The import mapping is Phase 4 work, but you want a real file to build against and a year of sales history to validate forecasting.

## Repository layout

```
apps/api            NestJS backend. The only thing that talks to Postgres.
apps/dashboard      Next.js owner and admin dashboard
apps/storefront     Next.js customer site
apps/pos-android    Kotlin / Jetpack Compose register
packages/db         SQL migrations, scripts, tests            ← built
packages/config     shared tsconfig, eslint, prettier         ← built
packages/contracts  Zod schemas -> TS types -> OpenAPI -> Kotlin client
packages/pricing-engine   TypeScript pricing, promotion and tax engine
packages/pricing-spec     Language neutral conformance fixtures for BOTH engines
services/worker     BullMQ processors
infra/              Docker, Terraform
docs/               Architecture and reference documentation
```

Tooling note: npm workspaces rather than pnpm and Turborepo. npm ships with Node, supports
workspaces fully, and adds no install step before a new machine can build. Turborepo can be added
later if build caching starts to pay for itself.

## The non negotiables

Written down here because they are the decisions that get quietly eroded under deadline pressure, and each one is expensive to reverse.

1. **No card data enters this system.** Ever. Semi integrated P2PE terminal, token only. This is the difference between a short self assessment and a full PCI audit.
2. **A completed sale is never lost and never duplicated.** Register generated UUIDv7, `ON CONFLICT DO NOTHING` intake, deterministic ledger ids.
3. **Financial and inventory history is append only.** A void is a new state. A correction is a new row. Enforced by triggers, not by convention.
4. **Everything sellable is a variant**, including products with only one.
5. **Compliance rules are data with effective dates**, and the engine fails closed.
6. **The pricing conformance suite runs in CI for both engines.** A rule change that passes in TypeScript and not in Kotlin is not merged.
7. **Nothing in checkout imports a hardware adapter.** Only `hardware-api`.
8. **The API connects as `snappos_app`, never as the table owner.** Ownership voids RLS.
