/**
 * Inventory contracts.
 *
 * The ledger is the truth and the level is a cache of it. That is not a
 * comment, it is the API surface: there is no endpoint anywhere in this system
 * that sets `on_hand` to a number. Stock changes only by posting a movement
 * with a reason, and the level is recomputed in the same transaction.
 *
 * A count is not an exception to that rule. Counting 11 where the system says
 * 12 posts a movement of -1 with reason `count_adjustment`, so the question
 * "where did that unit go" always has an answer.
 */

import { z } from 'zod';
import { uuid, uuidV7, quantity, costDecimal, timestamp, pagination } from './primitives.js';

/**
 * Every reason stock can move. A Postgres enum, so an unlisted reason is a
 * migration and a conversation, not an accident in a hurry.
 */
export const inventoryReason = z.enum([
  'sale',
  'refund',
  'receiving',
  'transfer_in',
  'transfer_out',
  'count_adjustment',
  'damage',
  'expired',
  'theft',
  'vendor_return',
  'promo_giveaway',
  'online_order',
  'online_cancel',
  'manual_adjustment',
  'opening_balance',
]);

/**
 * Reasons a human may post directly. Sales, refunds and online orders are
 * posted by the system as a consequence of a document existing, and letting a
 * user post one by hand would create stock movement with no sale behind it.
 */
export const manualInventoryReason = z.enum([
  'receiving',
  'count_adjustment',
  'damage',
  'expired',
  'theft',
  'vendor_return',
  'promo_giveaway',
  'manual_adjustment',
  'opening_balance',
]);

export const inventoryLevelSchema = z.object({
  store_id: uuid,
  variant_id: uuid,
  on_hand: quantity,
  reserved: quantity,
  /** Generated: on_hand - reserved. Read only, and never sent by a client. */
  available: quantity,
  updated_at: timestamp,
});

/** A stock level joined with enough catalog context to show in a list -- the raw `inventory_levels` row alone is just two ids and three numbers. */
export const stockLevelRowSchema = z.object({
  variant_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  sku: z.string(),
  on_hand: quantity,
  reserved: quantity,
  available: quantity,
  updated_at: timestamp.nullable(),
});

export const ledgerEntrySchema = z.object({
  id: uuid,
  store_id: uuid,
  variant_id: uuid,
  occurred_at: timestamp,
  delta: quantity,
  reason: inventoryReason,
  unit_cost: costDecimal.nullable(),
  reference_type: z.string().max(32).nullable(),
  reference_id: uuid.nullable(),
  actor_user_id: uuid.nullable(),
  note: z.string().max(512).nullable(),
  balance_after: quantity.nullable(),
});

/**
 * Post a stock movement.
 *
 * `delta` is signed and must not be zero: a movement of nothing is not a fact
 * about the world, and the database rejects it. Corrections are new rows with
 * the opposite sign, never edits.
 */
export const postMovementSchema = z
  .object({
    store_id: uuid,
    variant_id: uuid,
    delta: quantity,
    reason: manualInventoryReason,
    unit_cost: costDecimal.optional(),
    reference_type: z.string().max(32).optional(),
    reference_id: uuid.optional(),
    note: z.string().max(512).optional(),
    /**
     * Register generated UUIDv7. Makes the post idempotent: the same id
     * uploaded twice is one movement, whatever the network did.
     */
    idempotency_id: uuidV7.optional(),
  })
  .superRefine((v, ctx) => {
    if (/^-?0(\.0+)?$/.test(v.delta)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delta'],
        message: 'a zero movement records nothing; omit it',
      });
    }
    // Shrinkage reasons need a note. Without one the loss prevention report is
    // a list of numbers nobody can act on.
    const needsNote: readonly string[] = ['damage', 'theft', 'expired', 'manual_adjustment'];
    if (needsNote.includes(v.reason) && !v.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: `reason "${v.reason}" requires a note`,
      });
    }
  });

/** Several movements, one transaction. Receiving a purchase order uses this. */
export const postMovementBatchSchema = z.object({
  movements: z.array(postMovementSchema).min(1).max(500),
  reference_type: z.string().max(32).optional(),
  reference_id: uuid.optional(),
});

// ---------------------------------------------------------------- reservations

/**
 * A reservation holds stock for an online order between checkout and capture.
 * It expires, which is what stops an abandoned cart from making a product
 * unbuyable in the shop.
 */
export const reservationSchema = z.object({
  id: uuid,
  store_id: uuid,
  variant_id: uuid,
  quantity,
  state: z.enum(['active', 'committed', 'released', 'expired']),
  reason: z.string().max(32),
  reference_id: uuid.nullable(),
  expires_at: timestamp,
});

export const createReservationSchema = z.object({
  store_id: uuid,
  lines: z.array(z.object({ variant_id: uuid, quantity })).min(1),
  reference_id: uuid,
  ttl_seconds: z.number().int().min(30).max(3600).default(900),
});

// ---------------------------------------------------------------------- counts

export const countSchema = z.object({
  id: uuid,
  store_id: uuid,
  kind: z.enum(['full', 'cycle', 'spot', 'category', 'vendor']),
  state: z.enum(['open', 'counting', 'review', 'applied', 'cancelled']),
  /**
   * A blind count hides the expected quantity from the counter. It is the only
   * kind that measures anything: shown the expected number, people type it
   * back, and the count confirms itself rather than the shelf.
   */
  is_blind: z.boolean(),
  started_at: timestamp,
  applied_at: timestamp.nullable(),
});

export const countLineSchema = z.object({
  variant_id: uuid,
  expected: quantity.nullable(),
  counted: quantity,
  variance: quantity.nullable(),
});

export const submitCountLinesSchema = z.object({
  lines: z.array(z.object({ variant_id: uuid, counted: quantity })).min(1).max(1000),
});

/** Applying a count posts one `count_adjustment` movement per varying line. */
export const applyCountSchema = z.object({
  note: z.string().max(512).optional(),
});

export const ledgerQuerySchema = pagination.extend({
  store_id: uuid.optional(),
  variant_id: uuid.optional(),
  reason: inventoryReason.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export type InventoryReason = z.infer<typeof inventoryReason>;
export type InventoryLevel = z.infer<typeof inventoryLevelSchema>;
export type StockLevelRow = z.infer<typeof stockLevelRowSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type PostMovement = z.infer<typeof postMovementSchema>;
