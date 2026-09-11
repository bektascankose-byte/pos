# API

NestJS on Fastify. Base path `/api/v1`. Health is outside the prefix and version
neutral, because a load balancer check should not need to know which version is
current.

## Conventions

**Money** is a digit string of minor units: `"2499"` is $24.99. Never a number.
See [MONEY.md](MONEY.md).

**Quantities** are strings too — `numeric(14,3)`, because weighed goods exist.

**Ids** are UUIDs. Anything a register generates offline is a UUIDv7, and the
server checks the version rather than just the shape: a v4 means something used
the wrong generator, and v4 destroys the index locality the schema depends on.

**Timestamps** are ISO 8601 with an offset. A naive local time is ambiguous and
is rejected.

## Errors

Every failure has the same shape:

```json
{
  "code": "insufficient_stock",
  "message": "for developers",
  "user_message": "shown to a cashier, when one fits",
  "issues": [{ "path": "movements.0.delta", "message": "..." }],
  "request_id": "uuid",
  "retryable": false
}
```

`code` is stable and machine readable. `request_id` appears in the logs, so a
cashier's screenshot maps to exactly one log line.

`retryable` tells the register's sync queue whether to back off or dead letter.
It is set honestly: an inaccurate value either loses a sale or retries a doomed
request forever.

| Status | Codes |
|---|---|
| 400 | `validation_failed` |
| 401 | `unauthenticated`, `invalid_credentials`, `token_expired` |
| 403 | `forbidden`, `manager_approval_required` |
| 404 | `not_found` |
| 409 | `conflict`, `idempotency_key_reuse`, `insufficient_stock` |
| 422 | `compliance_blocked`, `age_verification_required` |
| 429 | `rate_limited` |
| 500 | `internal_error` |
| 503 | `provider_unavailable` |

## Idempotency

Any endpoint that moves money or stock requires an `Idempotency-Key` header and
**refuses without one**. Treating it as optional and hoping is how a timed out
retry deducts stock twice.

| Situation | Result |
|---|---|
| Same key, same body | The stored response, replayed |
| Same key, different body | `409 idempotency_key_reuse` — a client bug, not a replay |
| Same key, still running | `409` with `retryable: true` |

The body is hashed canonically (keys sorted recursively), so a client that
serializes its JSON in a different order on retry is still recognised as a replay.

The sync endpoint is the exception, and needs no header: every entity in a batch
already carries its own UUIDv7, which serves as the key. There is nothing
separate to get wrong.

## Endpoints

### Health

```
GET  /health           liveness. Does NOT touch the database: a probe that fails
                       during a brief blip gets the container killed and
                       restarted into the same blip.
GET  /health/ready     readiness. Does check the database.
```

### Auth

```
POST /api/v1/auth/login      { email, password, device_id? } -> token pair
POST /api/v1/auth/refresh    { refresh_token } -> a NEW pair; the old one dies
POST /api/v1/auth/logout     revokes one session
GET  /api/v1/auth/session    who am I, and what may I do
```

Refresh tokens rotate. Replaying a spent one revokes the entire family — see
[SECURITY.md](SECURITY.md).

### Organization

```
GET  /api/v1/stores          the register's first authenticated call
GET  /api/v1/registers
```

### Catalog

```
GET  /api/v1/catalog/scan/:barcode?store_id=    the hot path
GET  /api/v1/catalog/products?q=&store_id=&in_stock=
POST /api/v1/catalog/products                   product.create
GET  /api/v1/catalog/categories
POST /api/v1/catalog/categories                 product.create
```

`scan` returns price, stock and the age rule in **one** call. A register that had
to make three would be three times as likely to be slow at the wrong moment, and
the compliance prompt has to be decidable before the line renders.

Path and depth of a category are derived from the parent by the API and never
accepted from a client: a supplied path that disagreed with `parent_id` would
make the tree unnavigable.

### Inventory

```
GET  /api/v1/inventory/levels?store_id=&variant_ids=    inventory.view
GET  /api/v1/inventory/ledger?store_id=&variant_id=     inventory.view
POST /api/v1/inventory/movements                        inventory.adjust
GET  /api/v1/inventory/reconcile?store_id=              inventory.view
```

There is **no endpoint that sets `on_hand` to a number.** Stock changes only by
posting a movement with a reason, and the level is recomputed in the same
transaction. Counting 11 where the system says 12 posts `-1` with reason
`count_adjustment`, so "where did that unit go" always has an answer.

`reconcile` recomputes `sum(delta)` per store and variant and reports any
disagreement with the level. Drift means something wrote stock outside the
repository.

Reasons the system owns — `sale`, `refund`, `online_order` — cannot be posted by
a client. They are consequences of a document existing, and accepting one here
would create stock movement with no sale behind it.

Shrinkage reasons (`damage`, `theft`, `expired`, `manual_adjustment`) require a
note. Without one the loss prevention report is a list of numbers nobody can act
on.

### Sales, refunds and cash

```
GET  /api/v1/sales                      report.sales
GET  /api/v1/sales/:id                  sale.reprint
POST /api/v1/sales/:id/void             sale.void

GET  /api/v1/refunds                    report.sales
GET  /api/v1/refunds/for-sale/:saleId   refund.create

POST /api/v1/cash/sessions              cash.session_open
POST /api/v1/cash/sessions/:id/close    cash.session_close
GET  /api/v1/cash/sessions/:id          cash.session_open
GET  /api/v1/cash/sessions?register_id= cash.session_open
POST /api/v1/cash/movements             cash.paid_in_out

GET  /api/v1/audit                      audit.view
```

**There is no `POST /sales`.** A sale is composed on the register and arrives
through `/sync/batch`. Ringing a sale over HTTP would make selling depend on the
network, which is the one thing this architecture refuses.

A void is a new state, never a deletion, and it returns the stock through a new
ledger entry rather than by reversing the original — so the history reads as
"sold, then returned", which is what happened. A sale that has been partly
refunded cannot be voided: that would count the same return twice.

`/refunds/for-sale/:saleId` is what the register calls *before* offering a
refund, so a cashier is told "only 1 of 3 left" before promising a customer
anything rather than after. `quantity_refunded` on the original line is the one
mutable column in the financial schema, and it is locked `FOR UPDATE` during a
refund so two registers refunding the same receipt serialize rather than both
reading three.

Closing a drawer requires a different permission from opening one. Opening
commits nothing; closing produces the over/short number a shift is judged by,
and letting the person who is short report their own variance removes the only
check on it. Expected cash is `sum(amount_minor)` over the session's movements,
computed when asked — never a stored counter, which drifts the first time a
write is retried.

### Sync

```
POST /api/v1/sync/batch                          sync.upload
GET  /api/v1/sync/changes?since=&scopes=&limit=  sync.download
GET  /api/v1/sync/catalog?store_id=              sync.download
```

`/sync/catalog` is the **bootstrap**: everything one store sells, in a single
response, plus a cursor to resume the change feed from. A register calls it once
when claimed. The change feed cannot serve this purpose — it is a log of what
changed, and a device with an empty database has nothing to apply changes to.

Deliberately scoped to one store, and it carries **no customer data**: caching
the customer table on a terminal is a privacy problem with no operational
payoff, and the register looks a customer up by phone number when it needs one.

`/registers` returns `last_sequence` for each register. Receipt numbers are
composed on the device from a local counter so a receipt can print with no
network, which means a wiped or replaced terminal would restart at 1 and collide
with receipt numbers that already exist — the upload is then rejected by a unique
constraint and a legitimate sale can never be handed over. The server reports
where the register got to so a re-provisioned device resumes from there.

`sync.upload` gates the endpoint, and **each entity is additionally checked
against the permission that governs its own action** — `sale.create` for a sale,
`refund.create` for a refund, `inventory.adjust` for a stock movement. Without
that, a cashier who cannot issue a refund over `/refunds` could issue one by
putting it in a batch instead. A permission that does not govern every route
capable of the action governs nothing.

Upload is **ordered but not atomic**. Entity 7 failing must not block entities 1
to 6: one malformed row cannot hold a day of sales hostage. Each gets its own
verdict:

- `accepted` — inserted now
- `duplicate` — already present. **A success**, and the normal result of a retry.
  The register treats it identically to `accepted`.
- `rejected` — after five attempts it moves to `sync_dead_letter` and raises Sync
  Error, which a manager can see and a support engineer can inspect. Never a
  silent hole in the day's numbers.

The response carries `server_time` and a measured `clock_offset_ms`. Reports use
server time, so a register with a wrong clock cannot reorder the day's sales.

`changes` returns notifications, not rows: `entity_type`, `entity_id`, `op` and a
`payload_hash`. The register learns what changed and fetches the current version,
skipping the fetch when it already holds that hash.

The cursor is `change_log.id`, a bigserial, as a **string** — a bigserial outgrows
what a JSON number holds safely, and a cursor that silently rounds skips rows
forever.

The query is bounded by `sync_changes_watermark()`, not `max(id)`. A bigserial is
allocated *before* its transaction commits, so row 500 can become visible after
row 501; a reader consuming up to `max(id)` advances past 500 while it is still
invisible and never sees it. An empty page leaves the cursor where it was rather
than jumping forward.

## Versioning

URI versioned, `/api/v1`. A breaking change is a new version, because registers
in the field update on their own schedule and a shop must not stop selling
because the API moved.

## Not yet built

- OpenAPI generation from the Zod schemas (the schemas are the source of truth;
  the generator is not wired)
- The Kotlin client generator for the register
- Webhooks
- Promotions and the pricing engine (Phase 2, with the register)
- Held and parked transactions
- Receipt rendering and delivery
