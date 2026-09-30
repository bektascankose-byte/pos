/**
 * Send to POS.
 *
 * The registers are served the catalog as it was last sent, not as it is
 * being edited (migration 0034). These are the shapes of the page that shows
 * what is waiting and the request that sends it.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';

/**
 * `new`: never been on the registers. `changed`: on them, and edited since.
 * `removed`: on them, but archived or emptied of flavours in the back office.
 */
export const posChangeKind = z.enum(['new', 'changed', 'removed']);

export const posPendingProductSchema = z.object({
  product_id: uuid,
  product_name: z.string(),
  brand_name: z.string().nullable(),
  /** The product's main photo (its own, else its first flavour's), if it has one. */
  image_id: uuid.nullable(),
  kind: posChangeKind,
  /** What will change on the registers, in words: "Adds Honey Berry", "Price $6.55 to $6.99". */
  changes: z.array(z.string()),
  /** Why some or all of it cannot go yet: "Rum has no barcode yet". */
  problems: z.array(z.string()),
  /** At least one of the changes can be sent now. */
  sendable: z.boolean(),
  /** Flavours on sale in the back office right now. */
  variant_count: z.number().int(),
  updated_at: timestamp.nullable(),
});

export const posPendingSchema = z.object({
  products: z.array(posPendingProductSchema),
  last_release: z
    .object({
      created_at: timestamp,
      released_by: z.string().nullable(),
      product_count: z.number().int(),
    })
    .nullable(),
});

export const sendToPosSchema = z.object({
  product_ids: z.array(uuid).min(1).max(2000),
});

export const sendToPosResultSchema = z.object({
  /** Products that had something sent. */
  sent: z.number().int(),
  variants_added: z.number().int(),
  variants_changed: z.number().int(),
  variants_removed: z.number().int(),
  /** Variants held back because they are not ready, with the reason. */
  held_back: z.array(z.object({ product_id: uuid, variant_name: z.string(), reason: z.string() })),
});

/**
 * What removing a flavour did. A flavour that was never sold, received,
 * counted or sent to the registers is deleted outright; anything with history
 * is discontinued instead, so past sales and stock records keep their item.
 */
export const removeVariantResultSchema = z.object({
  outcome: z.enum(['deleted', 'discontinued']),
  /** Why it was discontinued rather than deleted. Null when deleted. */
  reason: z.string().nullable(),
});

export type PosChangeKind = z.infer<typeof posChangeKind>;
export type PosPendingProduct = z.infer<typeof posPendingProductSchema>;
export type PosPending = z.infer<typeof posPendingSchema>;
export type SendToPos = z.infer<typeof sendToPosSchema>;
export type SendToPosResult = z.infer<typeof sendToPosResultSchema>;
export type RemoveVariantResult = z.infer<typeof removeVariantResultSchema>;
