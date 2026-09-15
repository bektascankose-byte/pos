/**
 * Segments and campaigns.
 *
 * One rule shapes this whole file: **a send that cannot point at a consent
 * row does not go out.** It is not a validation a caller can skip, because it
 * is not expressed as a request field at all -- a campaign names a segment
 * and a body, and who is actually reachable is decided by the server against
 * `customer_consents` and `message_suppressions` at send time. There is no
 * "send anyway" flag, deliberately.
 *
 * A segment is stored as a structured definition rather than as SQL. A user
 * composes it in a form, so storing SQL would mean storing something someone
 * can edit into an injection; the server compiles these fields into a query
 * it wrote itself.
 */

import { z } from 'zod';
import { uuid, timestamp, moneyNonNegative } from './primitives.js';

export const messageChannel = z.enum(['email', 'sms']);
export const campaignStatus = z.enum(['draft', 'sending', 'sent', 'failed']);

/**
 * What makes someone a member of a segment. Every field is optional and they
 * combine with AND -- an empty definition is "every active customer", which
 * is a legitimate thing to want and is why it isn't rejected.
 *
 * Deliberately a short list. These are the four questions a shop actually
 * asks (who buys this, who spends, who has drifted away, who is tagged), and
 * a general-purpose query builder would be a far larger surface for a feature
 * nobody has asked for yet.
 */
export const segmentDefinitionSchema = z.object({
  /** Bought this specific product at least once (within `within_days`, if given). */
  bought_product_id: uuid.optional(),
  /** Bought anything in this category (within `within_days`, if given). */
  bought_category_id: uuid.optional(),
  /** Window for the two "bought" filters. Without it they mean "ever". */
  within_days: z.number().int().min(1).max(3650).optional(),
  /** Hasn't bought anything for at least this many days. The win-back question. */
  not_seen_days: z.number().int().min(1).max(3650).optional(),
  /** Lifetime spend, net of refunds, at or above this. */
  min_lifetime_spend_minor: moneyNonNegative.optional(),
  min_visits: z.number().int().min(1).max(10_000).optional(),
  has_tag: z.string().max(64).optional(),
});

export const segmentSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  definition: segmentDefinitionSchema,
  created_at: timestamp,
  updated_at: timestamp,
});

/**
 * How many people a segment actually reaches, which is never the same number
 * as how many it matches.
 *
 * `matched` is the answer to the question asked. `reachable` is how many of
 * those can lawfully be mailed: consented, not suppressed, and with an
 * address on the channel. Showing only the first would be the number that
 * gets a shop into trouble -- somebody sees "412 customers" and assumes that
 * is the size of the send.
 */
export const segmentPreviewSchema = z.object({
  matched: z.number().int(),
  reachable: z.number().int(),
  no_consent: z.number().int(),
  suppressed: z.number().int(),
  no_address: z.number().int(),
  /** A handful of matched customers, so a person can sanity-check the question. */
  sample: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      address: z.string().nullable(),
      reachable: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});

export const createSegmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  definition: segmentDefinitionSchema,
});

export const updateSegmentSchema = createSegmentSchema.partial();

export const campaignSchema = z.object({
  id: uuid,
  name: z.string(),
  channel: messageChannel,
  segment_id: uuid.nullable(),
  segment_name: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  status: campaignStatus,
  recipient_count: z.number().int(),
  sent_count: z.number().int(),
  failed_count: z.number().int(),
  skipped_count: z.number().int(),
  created_at: timestamp,
  sent_at: timestamp.nullable(),
});

export const campaignRecipientSchema = z.object({
  id: uuid,
  customer_id: uuid,
  customer_name: z.string(),
  address: z.string().nullable(),
  status: z.string(),
  skip_reason: z.string().nullable(),
  error: z.string().nullable(),
  sent_at: timestamp.nullable(),
});

/**
 * `body` accepts two placeholders and no more: `{{first_name}}` and
 * `{{shop_name}}`. Not a template language -- a template language in a field
 * a user types is an expression evaluator pointed at a customer database.
 */
export const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(120),
    channel: messageChannel,
    segment_id: uuid,
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(20_000),
  })
  .superRefine((v, ctx) => {
    if (v.channel === 'email' && !v.subject?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'an email needs a subject' });
    }
  });

export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(20_000).optional(),
  segment_id: uuid.optional(),
});

/** What a send actually did. Every number here is a count of recipient rows. */
export const campaignSendResultSchema = z.object({
  recipient_count: z.number().int(),
  sent_count: z.number().int(),
  failed_count: z.number().int(),
  skipped_count: z.number().int(),
  status: campaignStatus,
});

export const suppressionSchema = z.object({
  id: uuid,
  channel: messageChannel,
  address: z.string(),
  reason: z.string(),
  created_at: timestamp,
});

export type MessageChannel = z.infer<typeof messageChannel>;
export type CampaignStatus = z.infer<typeof campaignStatus>;
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type SegmentPreview = z.infer<typeof segmentPreviewSchema>;
export type CreateSegment = z.infer<typeof createSegmentSchema>;
export type UpdateSegment = z.infer<typeof updateSegmentSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignRecipient = z.infer<typeof campaignRecipientSchema>;
export type CreateCampaign = z.infer<typeof createCampaignSchema>;
export type UpdateCampaign = z.infer<typeof updateCampaignSchema>;
export type CampaignSendResult = z.infer<typeof campaignSendResultSchema>;
export type Suppression = z.infer<typeof suppressionSchema>;
