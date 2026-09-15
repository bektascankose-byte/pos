/**
 * Customer contracts.
 *
 * Deliberately minimal, matching the table: no date of birth beyond a
 * birthday (month and day, no year -- this is not an age database), no ID
 * data, no card numbers. A customer needs a phone or an email to be
 * reachable, which is the one rule enforced everywhere a customer is written:
 * in the database (`customers_contactable`), and here, so a bad request reads
 * as a 400 naming the rule rather than a raw constraint violation.
 *
 * Not part of the register's bootstrap or incremental sync. A register looks
 * a customer up live, by phone or name, when it needs one -- see
 * `customerSearchSchema` -- rather than holding a copy of the whole table on
 * a device that can be stolen. The back office browses the same endpoint
 * with no filter at all.
 */

import { z } from 'zod';
import { uuid, phone, email, entityStatus, timestamp, pagination } from './primitives.js';

export const customerSchema = z.object({
  id: uuid,
  first_name: z.string().max(120).nullable(),
  last_name: z.string().max(120).nullable(),
  phone: phone.nullable(),
  email: email.nullable(),
  birth_month: z.number().int().min(1).max(12).nullable(),
  birth_day: z.number().int().min(1).max(31).nullable(),
  home_store_id: uuid.nullable(),
  notes: z.string().max(2000).nullable(),
  tags: z.array(z.string().max(64)),
  status: entityStatus,
  created_at: timestamp,
  updated_at: timestamp,
});

const contactable = <T extends { phone?: string | undefined; email?: string | undefined }>(
  v: T,
) => v.phone !== undefined || v.email !== undefined;

export const createCustomerSchema = z
  .object({
    first_name: z.string().max(120).optional(),
    last_name: z.string().max(120).optional(),
    phone: phone.optional(),
    email: email.optional(),
    birth_month: z.number().int().min(1).max(12).optional(),
    birth_day: z.number().int().min(1).max(31).optional(),
    home_store_id: uuid.optional(),
    notes: z.string().max(2000).optional(),
    tags: z.array(z.string().max(64)).optional(),
  })
  .refine(contactable, { message: 'a customer needs a phone or an email', path: ['phone'] });

/**
 * Editing an existing customer. The same fields as create, but none are
 * required here -- a partial update only touches what it sends. This does
 * NOT mean a customer can end up with neither a phone nor an email: that
 * rule still holds, checked against the row as it would read after the
 * update, in `CustomersService.update`, not by this schema (the schema has
 * no way to know what the row already has).
 */
export const updateCustomerSchema = z.object({
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  phone: phone.optional(),
  email: email.optional(),
  birth_month: z.number().int().min(1).max(12).optional(),
  birth_day: z.number().int().min(1).max(31).optional(),
  home_store_id: uuid.optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(64)).optional(),
  /**
   * How a customer is removed. This app archives rather than deletes: sales,
   * refunds and loyalty history point at a customer, and deleting the row
   * would either break them or take them with it. An archived customer is
   * hidden from search -- including the register's -- and restorable.
   */
  status: entityStatus.optional(),
});

/**
 * A register searches one of two ways: an exact phone match (a loyalty
 * lookup -- the cashier types the number the program already knows the
 * customer by), or a free text match on name and email. The back office
 * browses a third way: no filter at all, a plain paginated list. All three
 * are the same endpoint and the same `customer.view` permission; nothing
 * here requires a filter to be present.
 */
export const customerSearchSchema = pagination.extend({
  phone: phone.optional(),
  q: z.string().min(1).max(128).optional(),
  /**
   * Defaults to active only, which is what the register must keep seeing. The
   * back office passes `archived` explicitly to review what it has removed.
   */
  status: entityStatus.optional(),
});

// ------------------------------------------------------------------- consent

/**
 * Marketing consent.
 *
 * `customer_consents` has existed since the first sales migration, carrying
 * the comment *"Consent is timestamped, sourced and never inferred. A
 * marketing send that cannot point at a row here does not go out."* Nothing
 * wrote to it until now. These schemas are that write path, and they keep the
 * rule literal: a customer with no row is not consented, silence is never
 * taken for agreement, and every grant records where it came from.
 *
 * The table is an append-only log, not a flag. Revoking does not delete the
 * grant -- it appends a `granted: false` row -- because proving someone *had*
 * opted in when a message went out is exactly what the log is for, and a
 * deleted grant proves nothing.
 */
export const consentChannel = z.enum(['sms', 'email']);

/**
 * Where a consent came from. `back_office` is the one that needs care: an
 * employee ticking a box on a customer's behalf, which is only legitimate if
 * something real happened (a signed slip, a verbal yes at the counter). That
 * is why granting requires a note saying what.
 */
export const consentSource = z.enum([
  'register',
  'web_signup',
  'sms_stop',
  'import',
  'back_office',
  /** Written by `marketing_unsubscribe`, never by a client -- see migration 0018. */
  'unsubscribe_link',
]);

/** One event in the log. */
export const consentEventSchema = z.object({
  id: uuid,
  channel: consentChannel,
  granted: z.boolean(),
  source: consentSource,
  evidence: z.record(z.unknown()),
  occurred_at: timestamp,
});

/** Where a customer stands right now, per channel: the latest event, or nothing at all. */
export const consentStateSchema = z.object({
  channel: consentChannel,
  granted: z.boolean(),
  source: consentSource.nullable(),
  occurred_at: timestamp.nullable(),
  /** No row has ever been written for this channel. Distinct from an explicit `false`. */
  never_asked: z.boolean(),
});

/**
 * The sources a *caller* may claim. Narrower than `consentSource` on purpose:
 * `import`, `sms_stop` and `unsubscribe_link` are written by machinery that
 * knows those things happened, and a client asserting one would be forging
 * the provenance the log exists to record.
 */
export const recordableConsentSource = z.enum(['register', 'web_signup', 'back_office']);

export const setConsentSchema = z
  .object({
    channel: consentChannel,
    granted: z.boolean(),
    source: recordableConsentSource,
    /**
     * What actually happened, in the employee's own words. Required when
     * granting: "never inferred" is only meaningful if someone has to say how
     * they know. Optional when revoking -- a customer asking to stop needs no
     * justification, and demanding one would be a reason not to record it.
     */
    note: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.granted && !v.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'say how this customer opted in — consent is recorded, never assumed',
      });
    }
  });

// ------------------------------------------------------------ purchase history

/** One product this customer actually buys, netted of refunds. */
export const customerTopProductSchema = z.object({
  product_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  quantity: z.string(),
  gross_minor: z.string(),
  last_bought_at: timestamp.nullable(),
});

/**
 * What a customer is worth and what they buy.
 *
 * Every figure nets refunds through `sale_lines.quantity_refunded` and counts
 * only completed sales, so "lifetime spend" is money the shop actually kept.
 */
export const customerHistorySchema = z.object({
  visit_count: z.number().int(),
  lifetime_spend_minor: z.string(),
  average_ticket_minor: z.string(),
  first_visit_at: timestamp.nullable(),
  last_visit_at: timestamp.nullable(),
  /** Days since the last visit, or null if they have never bought anything. */
  days_since_last_visit: z.number().int().nullable(),
  top_products: z.array(customerTopProductSchema),
  recent_sales: z.array(
    z.object({
      id: uuid,
      receipt_no: z.string(),
      completed_at: timestamp,
      total_minor: z.string(),
      line_count: z.number().int(),
    }),
  ),
});

export type Customer = z.infer<typeof customerSchema>;
export type CreateCustomer = z.infer<typeof createCustomerSchema>;
export type UpdateCustomer = z.infer<typeof updateCustomerSchema>;
export type CustomerSearch = z.infer<typeof customerSearchSchema>;
export type ConsentChannel = z.infer<typeof consentChannel>;
export type ConsentSource = z.infer<typeof consentSource>;
export type ConsentEvent = z.infer<typeof consentEventSchema>;
export type ConsentState = z.infer<typeof consentStateSchema>;
export type SetConsent = z.infer<typeof setConsentSchema>;
export type CustomerTopProduct = z.infer<typeof customerTopProductSchema>;
export type CustomerHistory = z.infer<typeof customerHistorySchema>;
