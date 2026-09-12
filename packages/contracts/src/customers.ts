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
});

export type Customer = z.infer<typeof customerSchema>;
export type CreateCustomer = z.infer<typeof createCustomerSchema>;
export type UpdateCustomer = z.infer<typeof updateCustomerSchema>;
export type CustomerSearch = z.infer<typeof customerSearchSchema>;
