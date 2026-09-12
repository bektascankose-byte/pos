/**
 * Sync contracts. Architecture section E.
 *
 * The guarantee these types exist to protect: a completed sale is never lost
 * and never duplicated, and the register never blocks on the network.
 *
 * Duplication is prevented structurally, not by remembering to check. Every
 * entity carries an id the register generated before it ever had a connection,
 * server intake is `ON CONFLICT DO NOTHING`, and a second delivery of the same
 * entity therefore inserts nothing and reports success. Retries can be as rude
 * as the network makes them.
 */

import { z } from 'zod';
import { uuid, uuidV7, deviceTime, timestamp } from './primitives.js';

/** Entities a register may push. Pull-only data is not listed here. */
export const syncEntityType = z.enum([
  'sale',
  // A void is its own entity rather than a mutation of the sale it voids.
  // Sales are append only on the register and the server alike, and an upload
  // that edits a row already delivered would have no idempotency key of its
  // own to make the retry safe.
  'sale_void',
  'refund',
  'payment',
  'cash_session',
  'cash_session_close',
  'cash_movement',
  'inventory_movement',
  'age_verification',
  'time_entry',
]);

/**
 * One item in an upload batch.
 *
 * `id` is the entity's own UUIDv7 and doubles as its idempotency key. There is
 * no separate key to get wrong, and no way to submit the same entity under two
 * different keys.
 */
export const syncEnvelopeSchema = z.object({
  id: uuidV7,
  entity_type: syncEntityType,
  /** Register's own clock. Evidence of ordering, never authority over it. */
  device_time: deviceTime,
  /** Bumped when a register legitimately amends an entity before acknowledgement. */
  attempt: z.number().int().min(0).default(0),
  payload: z.record(z.unknown()),
});

/**
 * The batch-level shape: deliberately lenient.
 *
 * Strict validation here would be a mistake, and was one. Validating the whole
 * array against `syncEnvelopeSchema` makes a single malformed entity fail the
 * request, so **one bad row rejects every sale behind it** — the exact opposite
 * of "ordered but not atomic", and a very real situation: a register running a
 * build from three months ago can emit an entity this server does not
 * recognise, and a shop's whole day should not be stuck behind it.
 *
 * So the envelope is checked loosely enough to route on, and each entity is
 * validated strictly inside its own transaction, where a failure produces a
 * per-entity verdict instead of an HTTP error.
 */
export const syncEnvelopeEnvelope = z.object({
  id: z.string().min(1).max(64),
  entity_type: z.string().min(1).max(64),
  device_time: z.string().min(1).max(64),
  attempt: z.number().int().min(0).default(0),
  payload: z.record(z.unknown()),
});

export const syncBatchSchema = z.object({
  register_id: uuid,
  device_id: uuid,
  /**
   * Ordered, but not atomic. Entity 7 failing must not block entities 1 to 6:
   * one bad row cannot be allowed to hold a day of sales hostage.
   */
  entities: z.array(syncEnvelopeEnvelope).min(1).max(200),
});

/**
 * Per entity outcome.
 *
 *   accepted  - inserted now
 *   duplicate - already present. A success, not an error. This is the normal
 *               result of a retry and the register treats it identically.
 *   rejected  - failed validation. After five attempts it moves to the dead
 *               letter queue and raises Sync Error, which a manager can see and
 *               a support engineer can inspect. Never a silent hole.
 */
export const syncResultSchema = z.object({
  id: uuidV7,
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  /** The server's canonical view, which the register adopts. */
  canonical: z.record(z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
});

export const syncBatchResponseSchema = z.object({
  results: z.array(syncResultSchema),
  /** Server time, so the register can measure and store its own clock offset. */
  server_time: timestamp,
  /** Measured drift in milliseconds. Reports always use server time. */
  clock_offset_ms: z.number().int(),
});

// ------------------------------------------------------------------ downstream

export const syncScope = z.enum([
  'catalog',
  'prices',
  'promotions',
  'compliance',
  'tax',
  'employees',
  'register_config',
  'customers',
]);

/**
 * The cursor is `change_log.id`, a bigserial, and not a timestamp. Two reasons:
 * device clocks drift, and two transactions committing in the same instant are
 * indistinguishable by time.
 *
 * It is a string because a bigserial exceeds what a JSON number represents
 * safely, and a cursor that silently rounds skips rows forever.
 */
/**
 * The bootstrap snapshot query.
 *
 * `store_id` is required, not optional. Prices, stock levels and the staff who
 * may unlock the register are all store scoped, so a snapshot taken without one
 * is not a smaller snapshot - it is a catalog with no prices, no stock and
 * nobody able to sign in. Returning that with a 200 leaves a register that
 * looks provisioned and cannot open, with nothing anywhere saying why.
 */
export const catalogQuerySchema = z.object({
  store_id: uuid,
  /** Omit for bootstrap; provide the last applied cursor for an atomic delta. */
  since: z.string().regex(/^\d+$/).optional(),
});

export const changesQuerySchema = z.object({
  since: z.string().regex(/^\d+$/).default('0'),
  scopes: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(syncScope).min(1))
    .optional(),
  store_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * A change notification, not the change itself.
 *
 * `change_log` stores a hash of the row rather than the row, which keeps the
 * table small on a counter that writes constantly and, more importantly, means
 * a replicated table can be reshaped without rewriting history. The register
 * uses this to learn WHAT changed and then fetches the current version.
 *
 * `payload_hash` lets it skip a fetch when it already holds that version, which
 * is the common case when two registers in one store sync seconds apart.
 */
export const changeSchema = z.object({
  id: z.string().regex(/^\d+$/),
  entity_type: z.string(),
  entity_id: uuid,
  op: z.enum(['insert', 'update', 'delete']),
  /** Derived from entity_type by the API; change_log does not store it. */
  scope: syncScope,
  payload_hash: z.string().nullable(),
});

export const changesResponseSchema = z.object({
  changes: z.array(changeSchema),
  /**
   * Where to resume. Held below the transaction watermark on purpose: a
   * bigserial is allocated before its transaction commits, so row 500 can
   * become visible after row 501, and a reader that consumes up to max(id)
   * skips row 500 permanently. The server never hands out a cursor past a
   * gap that might still fill in.
   */
  next_cursor: z.string().regex(/^\d+$/),
  has_more: z.boolean(),
  server_time: timestamp,
});

/** What the register shows in its header. Offline is amber, never red. */
export const syncStateSchema = z.enum(['online', 'syncing', 'offline', 'sync_error']);

export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>;
export type SyncBatch = z.infer<typeof syncBatchSchema>;
export type SyncResult = z.infer<typeof syncResultSchema>;
export type Change = z.infer<typeof changeSchema>;
