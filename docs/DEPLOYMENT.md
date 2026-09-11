# Deployment

## Environments

| | Database | Purpose |
|---|---|---|
| development | Docker compose, local | Day to day work |
| staging | Managed Postgres | Mirrors production; where a release is proved |
| production | Managed Postgres, PITR enabled | The shop |

## Local

```bash
npm install
npm run db:up        # Postgres 16, Redis 7, MinIO, Toxiproxy
npm run db:reset     # drop, create, bootstrap roles, migrate, seed
npm run dev:api
```

`npm run db:up` requires Docker. The schema suites also run on PGlite with no
daemon (`npm test`), which is the faster loop, but see [TESTING.md](TESTING.md)
for what PGlite cannot prove.

## Configuration

Environment variables only. Never a committed file. `apps/api/.env.example` lists
them.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | **Must point at `snappos_app`.** The API refuses to start if it detects a role that owns tables |
| `JWT_SECRET` | 32 characters minimum, required in production |
| `ACCESS_TOKEN_TTL` | Seconds. Default 900 |
| `REFRESH_TOKEN_TTL` | Seconds. Default 30 days |
| `PORT` | Default 3000 |
| `RATE_LIMIT_MAX` | Per minute. Default 300 |
| `TRUST_PROXY` | Only behind a proxy you control |
| `CORS_ORIGINS` | Comma separated. Empty disables CORS |

## First deploy to a new database

Order matters. The roles must exist before the first migration, because the
migration runner refreshes grants for `snappos_app` afterwards.

```bash
npm run bootstrap -w @snappos/db   # creates snappos_app, DML only, no BYPASSRLS
npm run migrate   -w @snappos/db   # applies migrations as snappos_migrator
```

Do **not** seed a production database. The seed writes known passwords and
refuses outright when `NODE_ENV=production`.

## Migrations

Applied as `snappos_migrator`, tracked in `schema_migrations` by name and
checksum. Each file runs in its own transaction, so a failure leaves the database
on the last known good migration rather than half applied.

**A file that has already been applied and then changed is a hard error.** At that
point the repository and the database disagree about what the schema is, and the
only safe action is to stop. Write a new migration.

Deploy order for a schema change: migrate first, then the application. Migrations
must therefore be backwards compatible with the currently running version —
add a column, backfill, switch reads, drop later. A migration that breaks the
running version takes the shop offline for the length of the deploy.

## Health checks

```
GET /health         liveness
GET /health/ready   readiness, includes the database
```

Point the orchestrator's **liveness** probe at `/health` and its **readiness**
probe at `/health/ready`. Liveness deliberately does not touch the database: a
liveness check that fails during a brief database blip gets the container killed
and restarted into the same blip, turning a ten second outage into a crash loop.

## Backups

Managed Postgres with point in time recovery. Daily full backup, WAL archiving,
30 day retention minimum.

**A backup nobody has restored is a hypothesis, not a backup.** Restore to a
scratch database quarterly and run the invariant suite against it. That proves
both that the backup is readable and that the schema guarantees survived the round
trip.

Financial records are append only by trigger, so the common recovery case is not
"restore the whole database" but "find what happened" — which the ledger and the
hash chained audit log already answer without a restore.

## Rollback

Application: redeploy the previous image.

Schema: forward only. A down migration that drops a column drops the data in it,
and on a financial schema that is not a rollback, it is a deletion. Fix forward
with a new migration.

## Scaling notes

Not required for one shop, recorded so nothing blocks it later:

- Rate limiting is currently **in-process**. It needs Redis backing before more
  than one API instance runs, or the effective limit multiplies by the instance
  count.
- The database pool is per instance. `DB_POOL_MAX × instances` must stay under
  the server's `max_connections`.
- The API is stateless apart from that; sessions live in the database.

## Not yet built

- Dockerfile for the API
- Terraform for staging and production
- CD pipeline (CI runs tests only)
- Log shipping and metrics export (OpenTelemetry is chosen, not wired)
- Sentry
