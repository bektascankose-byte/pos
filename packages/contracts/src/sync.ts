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
  'refund',
  'payment',
  'cash_session',
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

export const syncBatchSchema = z.object({
  register_id: uuid,
  device_id: uuid,
  /**
   * Ordered, but not atomic. Entity 7 failing must not block entities 1 to 6:
   * one bad row cannot be allowed to hold a day of sales hostage.
   */
  entities: z.array(syncEnvelopeSchema).min(1).max(200),
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

export const changeSchema = z.object({
  id: z.string().regex(/^\d+$/),
  entity_type: z.string(),
  entity_id: uuid,
  op: z.enum(['insert', 'update', 'delete']),
  scope: syncScope,
  payload: z.record(z.unknown()).nullable(),
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
