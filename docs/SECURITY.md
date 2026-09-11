# Security

## The one that matters most

**The API connects as `snappos_app`, never as the table owner.**

Row level security does not apply to a table's owner. If `DATABASE_URL` points at
`snappos_migrator`, every policy in `0005_rls.sql` becomes decoration: every query
still works, every test still passes, and tenant isolation is simply gone.

Because that failure is silent and total, it is checked three ways:

1. `DatabaseService` queries its own role at boot and refuses to start if it is a
   superuser, has `BYPASSRLS`, or owns any table.
2. `packages/db/test/rls.test.mjs` connects as `snappos_app` and proves the
   policies actually deny.
3. CI runs that suite against real Postgres, because PGlite cannot prove it.

| Role | Owns tables | Bypasses RLS | Used by |
|---|---|---|---|
| `snappos_migrator` | yes | yes, by ownership | migrations, seeds, backfills |
| `snappos_app` | no | no | the API, always |

`snappos_app` holds DML only. No DDL, no TRUNCATE: emptying a financial table is
not something the application may do, even with a bug.

## Tenancy

Three layers, defence in depth:

1. `org_id` on every tenant table, and composite foreign keys `(id, org_id)` so a
   row physically cannot reference a parent in another organization.
2. Every request runs inside `withOrg()`, which issues `SET LOCAL app.org_id`.
   `SET LOCAL` reverts on commit or rollback; a plain `SET` would leak one
   request's context into the next request on a pooled connection.
3. RLS policies that evaluate to NULL, and therefore deny, when `app.org_id` is
   unset. **Fail closed.** A forgotten context returns nothing, never another
   tenant's rows.

### The two deliberate exceptions

Authentication has a chicken and egg problem: the organization is not known until
the user is found, so the query that finds them cannot be org scoped.

Migration `0007` resolves that with two `SECURITY DEFINER` functions,
`auth_lookup_user` and `auth_lookup_session`. They are the **only** cross tenant
reads in the system. Each returns a fixed column list, pins `search_path` (a
`SECURITY DEFINER` function with a mutable search path can be hijacked by a caller
who creates a shadow table earlier in it), and has `EXECUTE` revoked from `PUBLIC`
before being granted to `snappos_app` alone.

`auth_lookup_session` takes a SHA-256 hash, never a raw token, so a query log or a
statement sample cannot leak a working session.

## Authentication

**Passwords** — Argon2id at OWASP's baseline (19456 KiB, t=2, p=1), roughly 50ms.
Invisible to a person signing in once; ruinous to anyone working through a leaked
password list.

A login for an unknown account still performs a dummy verification, so a missing
account and a wrong password take the same time. Response latency must not
enumerate valid email addresses.

**PINs** — the same algorithm with far cheaper parameters, because a cashier
unlocks a register hundreds of times a shift and 50ms each time is felt at a
counter. A four digit PIN has 10,000 possibilities, so hashing cost was never the
protection: lockout after five failures for fifteen minutes is. A PIN
authenticates against a device already claimed by a real login, and is never
accepted by the HTTP API.

**Access tokens** — 15 minutes, carrying the permission set so the hot path does
not hit the database to decide whether a cashier may discount a line. The cost is
staleness, and it is bounded deliberately: anything genuinely dangerous (refund,
price override, drawer open) additionally requires a manager PIN checked live
against the database, so a revoked manager cannot approve anything even with a
valid token in hand.

**Refresh tokens** — opaque random bytes, not JWTs, stored only as a SHA-256 hash.
They rotate: using one invalidates it. Presenting a spent token means two parties
hold it, which means one of them stole it; there is no way to tell which, so the
whole family is revoked and both are signed out. A legitimate user signing in
again is a far better outcome than an attacker holding a session indefinitely.

## Authorization

Permissions are `resource.action` rows in the database, not constants in code, so
a custom role is data rather than a deploy. The guard is registered globally and
opting out is an explicit `@Public()` decorator: the reverse default, protection
added per route, eventually ships an unguarded endpoint.

`@RequirePermissions(a, b)` requires **all** of them. "Any" would quietly widen
access as routes grow.

### The sync route is governed per entity, not per batch

`sync.upload` says a device may talk to the endpoint. It must not also mean "and
may therefore push anything at all", or a cashier who cannot issue a refund over
HTTP could issue one by putting it in a batch instead. `PERMISSION_BY_ENTITY`
maps each entity type to the permission that governs the action, so the
permission that guards a route guards it everywhere the action can be performed.

### Delegated authority, verified rather than trusted

A register uploads under the **cashier's** token, and a cashier does not hold
`refund.create`. But a manager standing at the counter can approve a refund by
PIN, on a register with no network, hours before that refund uploads. Checking
the uploader's permissions would reject a refund that was properly authorised;
granting the cashier `refund.create` would let them refund alone.

So for entity types listed in `APPROVER_FIELD_BY_ENTITY`, authority comes from
the user the payload names — `approved_by` for a refund. That name is **not**
taken on faith. The server looks the user up inside the request's org, under
RLS, and requires that they are `active` and actually hold the permission. A
register that names the cashier themselves, names a manager from another
organization, or names a user whose access has since been revoked is refused
exactly like one that names nobody. Revocation therefore takes effect on the
sync path too, which matters because a stolen device would otherwise keep a
former manager's authority indefinitely.

The on device PIN check is a **usability** control, not the security boundary:
it decides what the register lets a cashier do at the counter. The server's
lookup is the boundary, and it assumes the device may lie.

## Payment card data

**No card data enters this system. Ever.** Semi integrated P2PE terminal, tokens
only. This is the difference between a short self assessment questionnaire and a
full PCI audit, and it is a one way door: a cheap non-P2PE reader or a "temporary"
manual entry screen converts one into the other. The schema has nowhere to put a
PAN — `payments.card_last4` is constrained to four characters.

## Error handling

One error shape everywhere, from `packages/contracts`. Unexpected errors become a
generic 500 with a request id; the detail goes to the log. A Postgres error
message can contain a constraint name, a column list, or the value that violated
it, and on this schema that value may be a customer's phone number.

`retryable` is set honestly because the register's sync queue reads it to choose
between backing off and dead lettering. An inaccurate value either loses a sale or
retries a doomed request forever.

## Transport and headers

TLS everywhere. Helmet with a restrictive CSP, since the API serves JSON and never
HTML. Rate limiting keyed by token where present and IP otherwise, so one busy
register cannot exhaust the budget for every other register behind the same shop
IP. `trustProxy` is off unless explicitly enabled: trusting it blindly lets a
client spoof `X-Forwarded-For` and defeat per-IP limits.

## Secrets

Never in the repository. `JWT_SECRET` must be at least 32 characters and is
required in production; development generates a random one per start, which
invalidates tokens on restart and is far better than a default that ships.

## Audit

`audit_log` is partitioned by month and hash chained per organization: each row
stores `prev_hash` and `hash`. A broken chain means someone edited history in the
database directly, which is exactly what a loss prevention system must be able to
prove. The chain is sealed by a single serialized worker rather than a trigger,
because triggers cannot order concurrent inserts without taking a lock that would
slow down checkout.

## Not yet built

Stated plainly so nobody assumes coverage that does not exist:

- MFA. The `users.mfa_secret_enc` column exists; there is no flow yet.
- Audit log **writes** from the API. The table and its guarantees exist; the API
  does not write to it until Phase 2, with the register.
- Certificate pinning on Android.
- Secret management integration. Currently environment variables.
- Rate limiting is in-process and needs Redis backing before more than one API
  instance runs.
