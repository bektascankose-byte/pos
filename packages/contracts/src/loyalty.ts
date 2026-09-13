/**
 * Loyalty program settings -- configuration only, no engine.
 *
 * This defines the rates and on/off switch a business sets for its loyalty
 * program. Nothing in this system yet earns a point on a completed sale or
 * redeems one at checkout -- that's the register-touching "engine" half of
 * loyalty, deliberately out of scope here. Saving these settings changes
 * nothing about how a sale rings up today.
 */

import { z } from 'zod';
import { timestamp } from './primitives.js';

export const loyaltySettingsSchema = z.object({
  name: z.string().min(1).max(128),
  is_active: z.boolean(),
  earn_points_per_dollar: z.string(),
  redemption_points_per_dollar: z.string(),
  minimum_redemption_points: z.number().int().nonnegative().nullable(),
  points_expire_after_days: z.number().int().positive().nullable(),
  updated_at: timestamp,
});

export const updateLoyaltySettingsSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  is_active: z.boolean().optional(),
  earn_points_per_dollar: z
    .string()
    .regex(/^\d{1,7}(\.\d{1,2})?$/, 'up to two decimal places')
    .optional(),
  redemption_points_per_dollar: z
    .string()
    .regex(/^\d{1,7}(\.\d{1,2})?$/, 'up to two decimal places')
    .optional(),
  /**
   * Omitted means unchanged, matching every other partial-update endpoint in
   * this API. Like those, this has no way to clear a field that was already
   * set back to null -- a real gap, deferred the same way it was for
   * employees and customers.
   */
  minimum_redemption_points: z.number().int().nonnegative().optional(),
  points_expire_after_days: z.number().int().positive().optional(),
});

export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;
export type UpdateLoyaltySettings = z.infer<typeof updateLoyaltySettingsSchema>;
