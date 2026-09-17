/**
 * The back office's side of the website: which items are listed, which keys
 * the storefront may use, and which rules decide what may be sold online.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';

const minor = z.string().regex(/^-?\d+$/, 'money must be a whole number of minor units');

export const onlineAvailabilitySchema = z.enum(['hidden', 'pickup_only', 'delivery_only', 'pickup_and_delivery']);

/** One variant's online settings, next to what the counter knows about it. */
export const variantListingSchema = z.object({
  variant_id: uuid,
  variant_name: z.string().nullable(),
  upc: z.string(),
  /** No listing row reads as hidden: an item is off the website until someone puts it on. */
  availability: onlineAvailabilitySchema,
  safety_stock: z.string(),
  max_per_order: z.string().nullable(),
  online_price_minor: minor.nullable(),
  regular_price_minor: minor.nullable(),
  on_hand: z.string(),
  /** What the website may sell: on hand, less anything held, less the safety stock. */
  sellable: z.string(),
});

export const storefrontClientSchema = z.object({
  id: uuid,
  name: z.string(),
  store_id: uuid,
  /** The start of the key, so two keys can be told apart. The rest is never shown again. */
  key_prefix: z.string(),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
});

export const createStorefrontClientSchema = z.object({
  store_id: uuid,
  name: z.string().trim().min(1).max(100),
});

/** Returned once, at creation. The key is not stored and cannot be shown again. */
export const createdStorefrontClientSchema = z.object({
  client: storefrontClientSchema,
  key: z.string(),
});

export const complianceChannelSchema = z.enum(['in_store', 'pickup', 'delivery', 'online_listing', 'ship']);
export const complianceEffectSchema = z.enum([
  'allow',
  'deny',
  'require_age',
  'require_id_scan',
  'require_manager',
  'require_provider_verification',
]);

/**
 * A platform rule an organization has taken out of force for itself.
 *
 * The platform ships some rules switched off pending legal review -- delivery
 * of ENDS is the one that matters here. A shop cannot end a platform rule, and
 * cannot outweigh it with an allow, because a deny ends an evaluation wherever
 * it appears. It lifts the rule instead, which stops the rule being in force
 * for that shop alone and leaves the engine untouched.
 */
export const complianceRuleLiftSchema = z.object({
  id: uuid,
  /** The day counsel reviewed it. Not the day somebody wanted delivery switched on. */
  counsel_reviewed_on: z.string(),
  /** The permit or licence the shop trades under. An auditor asks for this one first. */
  permit_reference: z.string(),
  authority_note: z.string(),
  effective_from: timestamp,
  effective_to: timestamp.nullable(),
});

/** What an owner has to put on record to lift one. Every field is required. */
export const liftComplianceRuleSchema = z.object({
  counsel_reviewed_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, as YYYY-MM-DD'),
  permit_reference: z.string().trim().min(1).max(120),
  authority_note: z.string().trim().min(10).max(1000),
});

/** Withdrawing one. A reason, because the shop stops trading on it the moment this lands. */
export const withdrawComplianceRuleLiftSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const complianceRuleViewSchema = z.object({
  id: uuid,
  /**
   * True for a rule the platform ships. A shop never edits or ends one; where
   * the platform ships a hold pending legal review, the shop lifts it instead
   * and the attestation is kept with it.
   */
  platform: z.boolean(),
  /** For a platform rule: this shop has taken it out of force, and on what authority. */
  lift: complianceRuleLiftSchema.nullable(),
  name: z.string(),
  priority: z.number().int(),
  effect: complianceEffectSchema,
  effect_age: z.number().int().nullable(),
  channel: complianceChannelSchema.nullable(),
  scope_country: z.string().nullable(),
  scope_region: z.string().nullable(),
  subject_category_path_prefix: z.string().nullable(),
  subject_regulated_class: z.string().nullable(),
  deny_message: z.string().nullable(),
  authority_note: z.string().nullable(),
  effective_from: timestamp,
  effective_to: timestamp.nullable(),
  /** In force right now. */
  live: z.boolean(),
});

/**
 * A rule the shop adds for its own website.
 *
 * Deliberately narrower than the table: an effect, a channel, optionally a
 * category, and a note saying why. Rules are never edited -- a change is a
 * new rule and the old one ended -- so the history of what was allowed when
 * stays readable.
 */
export const createComplianceRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    effect: z.enum(['allow', 'deny', 'require_age']),
    effect_age: z.number().int().min(18).max(25).optional(),
    channel: z.enum(['pickup', 'delivery']),
    /** A category path such as `vapes`. The rule covers that category and everything beneath it. */
    category_path: z.string().trim().max(200).optional(),
    deny_message: z.string().trim().max(300).optional(),
    /** Why this rule exists: the law, the permit, the decision. Required, because an auditor will ask. */
    authority_note: z.string().trim().min(10).max(1000),
  })
  .refine((rule) => rule.effect !== 'require_age' || rule.effect_age !== undefined, {
    message: 'an age rule needs an age',
    path: ['effect_age'],
  });

export type OnlineAvailability = z.infer<typeof onlineAvailabilitySchema>;
export type VariantListing = z.infer<typeof variantListingSchema>;
export type StorefrontClient = z.infer<typeof storefrontClientSchema>;
export type CreatedStorefrontClient = z.infer<typeof createdStorefrontClientSchema>;
export type ComplianceRuleView = z.infer<typeof complianceRuleViewSchema>;
export type CreateComplianceRule = z.infer<typeof createComplianceRuleSchema>;
export type ComplianceRuleLift = z.infer<typeof complianceRuleLiftSchema>;
export type LiftComplianceRule = z.infer<typeof liftComplianceRuleSchema>;
export type WithdrawComplianceRuleLift = z.infer<typeof withdrawComplianceRuleLiftSchema>;
