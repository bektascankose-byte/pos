/**
 * Receiving: counting a delivery that arrived before its paperwork.
 *
 * Distinct from both existing ways stock comes in. A purchase order is
 * received against what was ordered; an invoice import is parsed from a
 * document. This is neither — it is somebody standing over a box with a
 * scanner, recording what physically turned up, with the vendor and the
 * invoice attached later if at all.
 *
 * The rule that shapes it: **an unrecognized code is not an error.** Scanning
 * something the catalog has never seen is the most common moment for a new
 * product to enter a shop, so the line is kept with whatever was scanned and
 * a human decides what it is before the session can be committed.
 */

import { z } from 'zod';
import { uuid, timestamp, quantity, costDecimal, moneyNonNegative, sku } from './primitives.js';

export const receivingStatus = z.enum(['open', 'committed', 'cancelled']);

export const receivingLineSchema = z.object({
  id: uuid,
  variant_id: uuid.nullable(),
  scanned_code: z.string(),
  /** Set whenever `variant_id` is -- display only, never sent by a client. */
  product_name: z.string().nullable(),
  variant_name: z.string().nullable(),
  sku: z.string().nullable(),
  quantity,
  unit_cost: costDecimal.nullable(),
  note: z.string().nullable(),
  /** This line named itself from the old system's item file rather than from a person -- so its price is that file's price, and is worth a look. */
  filled_from_reference: z.boolean(),
  created_at: timestamp,
});

export const receivingSessionSchema = z.object({
  id: uuid,
  store_id: uuid,
  vendor_id: uuid.nullable(),
  vendor_name: z.string().nullable(),
  invoice_import_id: uuid.nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  status: receivingStatus,
  line_count: z.number().int(),
  /** Lines whose code matched nothing yet. Committing is refused while this is above zero. */
  unresolved_count: z.number().int(),
  created_at: timestamp,
  committed_at: timestamp.nullable(),
  lines: z.array(receivingLineSchema).optional(),
});

export const createReceivingSessionSchema = z.object({
  store_id: uuid,
  vendor_id: uuid.optional(),
  reference: z.string().max(64).optional(),
  note: z.string().max(1000).optional(),
});

/**
 * Scanning a box in one go: one code per line, pasted or scanned straight
 * into a text area.
 *
 * Repeats are counted rather than rejected — scanning the same item four
 * times is how you record four of them, which is exactly what someone with a
 * scanner and a box of identical vapes will do.
 */
export const bulkScanSchema = z.object({
  codes: z.array(z.string().min(1).max(64)).min(1).max(1000),
});

export const addReceivingLineSchema = z.object({
  scanned_code: z.string().min(1).max(64),
  quantity: quantity.optional(),
  unit_cost: costDecimal.optional(),
  note: z.string().max(512).optional(),
});

export const updateReceivingLineSchema = z.object({
  variant_id: uuid.optional(),
  quantity: quantity.optional(),
  unit_cost: costDecimal.optional(),
  note: z.string().max(512).optional(),
});

/**
 * Create a product from an unrecognized scan, and point the line at it.
 *
 * `price_group_id` is here because picking a group is how a price gets set
 * without typing one: the group already has a price, and a new member should
 * take it. `price_minor` still wins when both are given -- an explicit price
 * is an explicit decision.
 */
export const createProductForScanSchema = z.object({
  name: z.string().min(1).max(256),
  variant_name: z.string().max(128).optional(),
  sku: sku.optional(),
  brand_id: uuid.optional(),
  brand_name: z.string().max(128).optional(),
  category_id: uuid.optional(),
  price_group_id: uuid.optional(),
  price_minor: moneyNonNegative.optional(),
  cost: costDecimal.optional(),
});

/**
 * What matching an invoice against a counted delivery found.
 *
 * Three buckets, and the middle one is the reason this exists: things the
 * invoice billed that nobody scanned. That is either a short shipment or a
 * box still in the van, and both are worth knowing before the bill is paid.
 */
export const receivingMatchSchema = z.object({
  invoice_import_id: uuid,
  matched: z.array(
    z.object({
      sku: z.string(),
      label: z.string(),
      received_quantity: quantity,
      invoiced_quantity: quantity.nullable(),
      /** Received minus invoiced. Zero is agreement; anything else needs a look. */
      difference: z.string(),
    }),
  ),
  /** Billed, but never scanned. Short shipment, or still on the van. */
  invoiced_not_received: z.array(
    z.object({ sku: z.string().nullable(), label: z.string(), invoiced_quantity: quantity.nullable() }),
  ),
  /** Scanned, but not on this invoice. A different delivery, or an unbilled extra. */
  received_not_invoiced: z.array(
    z.object({ sku: z.string().nullable(), label: z.string(), received_quantity: quantity }),
  ),
  /** Plain sentences for the screen, worst first. */
  warnings: z.array(z.string()),
});

export type ReceivingStatus = z.infer<typeof receivingStatus>;
export type ReceivingLine = z.infer<typeof receivingLineSchema>;
export type ReceivingSession = z.infer<typeof receivingSessionSchema>;
export type CreateReceivingSession = z.infer<typeof createReceivingSessionSchema>;
export type BulkScan = z.infer<typeof bulkScanSchema>;
export type AddReceivingLine = z.infer<typeof addReceivingLineSchema>;
export type UpdateReceivingLine = z.infer<typeof updateReceivingLineSchema>;
export type CreateProductForScan = z.infer<typeof createProductForScanSchema>;
export type ReceivingMatch = z.infer<typeof receivingMatchSchema>;
