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
 * a device that can be stolen.
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
 * A register searches one of two ways: an exact phone match (a loyalty
 * lookup -- the cashier types the number the program already knows the
 * customer by), or a free text match on name and email. At least one is
 * required; an unfiltered scan of every customer in an org is not a lookup.
 */
export const customerSearchSchema = pagination
  .extend({
    phone: phone.optional(),
    q: z.string().min(1).max(128).optional(),
  })
  .refine((v) => v.phone !== undefined || v.q !== undefined, {
    message: 'search needs a phone or a name/email query',
    path: ['q'],
  });

export type Customer = z.infer<typeof customerSchema>;
export type CreateCustomer = z.infer<typeof createCustomerSchema>;
export type CustomerSearch = z.infer<typeof customerSearchSchema>;
