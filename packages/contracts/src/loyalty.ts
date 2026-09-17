/**
 * Loyalty: the program's settings, the points ledger, and the arithmetic that
 * turns a sale into points.
 *
 * Points are earned by completed sales with a customer attached, at the
 * counter and on the website alike -- both arrive through the same sale intake,
 * which is where points are worked out. A void or a refund takes back what the
 * sale earned. Redeeming points at a till is not built yet; what the balance
 * is worth is shown so a customer knows what they have.
 */

import { z } from 'zod';
import { timestamp, uuid } from './primitives.js';

/** Money off the wire: a digit string of minor units. */
const minor = z.string().regex(/^-?\d+$/, 'money must be a whole number of minor units');

const rate = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, 'up to two decimal places');

export const loyaltySettingsSchema = z.object({
  name: z.string().min(1).max(128),
  is_active: z.boolean(),
  earn_points_per_dollar: z.string(),
  redemption_points_per_dollar: z.string(),
  minimum_redemption_points: z.number().int().nonnegative().nullable(),
  points_expire_after_days: z.number().int().positive().nullable(),
  /** Product classes whose sales never earn points. */
  excluded_regulated_classes: z.array(z.string()),
  updated_at: timestamp,
});

export const updateLoyaltySettingsSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  is_active: z.boolean().optional(),
  earn_points_per_dollar: rate.optional(),
  redemption_points_per_dollar: rate.optional(),
  /**
   * Omitted means unchanged, matching every other partial-update endpoint in
   * this API. Like those, this has no way to clear a field that was already
   * set back to null -- a real gap, deferred the same way it was for
   * employees and customers.
   */
  minimum_redemption_points: z.number().int().nonnegative().optional(),
  points_expire_after_days: z.number().int().positive().optional(),
  excluded_regulated_classes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
});

// -----------------------------------------------------------------------------
// The arithmetic
// -----------------------------------------------------------------------------

/** A two-decimal rate string as hundredths, so no float ever touches a point. */
function hundredths(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`"${value}" is not a valid points rate`);
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/**
 * Points for an amount spent, rounded down.
 *
 * `basisMinor` is what counted -- the price paid before tax, for the lines that
 * earn -- in cents. At 1 point per dollar, $39.98 earns 39: a customer earns a
 * point for each whole dollar, never a point for a dollar they did not spend.
 */
export function pointsForBasis(basisMinor: bigint, pointsPerDollar: string): number {
  if (basisMinor <= 0n) return 0;
  // basis cents * (rate hundredths) / (100 cents a dollar * 100 hundredths)
  return Number((basisMinor * hundredths(pointsPerDollar)) / 10_000n);
}

/**
 * What a number of points is worth when spent, in cents, rounded down.
 * At 100 points a dollar, 250 points is $2.50.
 */
export function pointsValueMinor(points: number, redemptionPointsPerDollar: string): bigint {
  const per = hundredths(redemptionPointsPerDollar);
  if (points <= 0 || per === 0n) return 0n;
  return (BigInt(points) * 10_000n) / per;
}

// -----------------------------------------------------------------------------
// The ledger, as the back office reads it
// -----------------------------------------------------------------------------

export const loyaltyEntryKindSchema = z.enum(['earn', 'reverse', 'redeem', 'adjust', 'expire']);

export const loyaltyEntrySchema = z.object({
  id: uuid,
  kind: loyaltyEntryKindSchema,
  points: z.number().int(),
  sale_id: uuid.nullable(),
  refund_id: uuid.nullable(),
  /** The receipt or order number, when the entry came from a sale. */
  receipt_no: z.string().nullable(),
  /** 'in_store', 'pickup' or 'delivery' when it came from a sale. */
  channel: z.string().nullable(),
  basis_minor: minor.nullable(),
  note: z.string().nullable(),
  occurred_at: timestamp,
});

export const customerLoyaltySchema = z.object({
  program_name: z.string(),
  program_active: z.boolean(),
  points: z.number().int(),
  lifetime_earned: z.number().int(),
  value_minor: minor,
  /** Whether this customer can sign in on the website, and whether they proved their phone there. */
  has_online_account: z.boolean(),
  phone_verified: z.boolean(),
  entries: z.array(loyaltyEntrySchema),
});

/** A person correcting a balance. Always with a reason, which the customer's history shows. */
export const loyaltyAdjustmentSchema = z.object({
  points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'a change of zero records nothing'),
  note: z.string().trim().min(3).max(300),
});

export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;
export type UpdateLoyaltySettings = z.infer<typeof updateLoyaltySettingsSchema>;
export type LoyaltyEntryKind = z.infer<typeof loyaltyEntryKindSchema>;
export type LoyaltyEntry = z.infer<typeof loyaltyEntrySchema>;
export type CustomerLoyalty = z.infer<typeof customerLoyaltySchema>;
export type LoyaltyAdjustment = z.infer<typeof loyaltyAdjustmentSchema>;
