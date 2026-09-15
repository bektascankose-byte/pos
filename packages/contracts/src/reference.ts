/**
 * The reference catalog: products the shop knows about but does not stock.
 *
 * A legacy system's item file is mostly history — thousands of rows of
 * everything ever scanned, against the few hundred things actually on the
 * shelf. See migration 0020 for why it lives in its own table rather than as
 * inactive products.
 *
 * Nothing here is sellable. These shapes exist to answer "what is this?" at a
 * scanner, and to carry that answer into a real catalog item in one step when
 * the thing turns out to be genuinely stocked.
 */

import { z } from 'zod';
import { uuid, timestamp, moneyNonNegative, costDecimal } from './primitives.js';

export const referenceProductSchema = z.object({
  id: uuid,
  source: z.string(),
  scan_code: z.string(),
  item_code: z.string().nullable(),
  description: z.string().nullable(),
  department: z.string().nullable(),
  size: z.string().nullable(),
  retail_minor: moneyNonNegative.nullable(),
  cost: costDecimal.nullable(),
  units_per_case: z.number().int().nullable(),
  /**
   * What the old system last believed was on hand. Evidence that this is a
   * live line, never an authority — stock comes from the ledger alone.
   */
  source_quantity: z.string().nullable(),
  created_at: timestamp,
});

/**
 * A search row, which additionally knows whether the shop already sells this.
 * Search is the list someone picks from when deciding what to add, so a row
 * that is already a real product has to say so rather than offering again.
 */
export const referenceSearchRowSchema = referenceProductSchema.extend({
  stocked_variant_id: uuid.nullable(),
});

export const referenceLookupSchema = z.object({
  /** The reference row, when the code is one this shop has a record of. */
  match: referenceProductSchema.nullable(),
  /**
   * The variant this code already resolves to, if any. Answered alongside the
   * lookup because the useful question at a scanner is not "is this in the
   * file" but "do I already sell this, and if not, what is it".
   */
  already_stocked: uuid.nullable(),
});

export const referenceSearchSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const referenceSourceStatsSchema = z.object({
  source: z.string(),
  total: z.number().int(),
  with_stock: z.number().int(),
  last_import: timestamp.nullable(),
});

/**
 * Turning a reference row into a real product.
 *
 * Every field is optional: the point of the reference file is that the name,
 * price, cost and case size are already known. An override is for the cases
 * where the old data was wrong, not for re-entering it.
 */
export const promoteReferenceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category_id: uuid.optional(),
  brand_id: uuid.optional(),
  price_minor: moneyNonNegative.optional(),
  cost: costDecimal.optional(),
});

export type ReferenceProduct = z.infer<typeof referenceProductSchema>;
export type ReferenceSearchRow = z.infer<typeof referenceSearchRowSchema>;
export type ReferenceLookup = z.infer<typeof referenceLookupSchema>;
export type ReferenceSourceStats = z.infer<typeof referenceSourceStatsSchema>;
export type PromoteReference = z.infer<typeof promoteReferenceSchema>;
