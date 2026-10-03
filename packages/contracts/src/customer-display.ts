/**
 * The customer's own screen at the counter.
 *
 * Everything else that writes a customer is an employee acting: `customer.manage`
 * gates creating one, editing one and recording consent, because those are a
 * member of staff vouching for a fact. These contracts are for the other case,
 * the customer typing on the screen that faces them. The register is signed in
 * as whoever is on shift, so the request still carries an employee, but the
 * employee is not the one asserting anything, and a cashier without
 * `customer.manage` must still be able to let a customer join.
 *
 * So the writes here are deliberately narrower than the back office's, and
 * each is shaped so the screen cannot be used to damage a record:
 *
 * - joining takes a phone or an email and nothing else. No name, no notes, no
 *   tags. A stranger at a keypad gets to add one contact and no more.
 * - a birthday can be given once. A member who already has one is not asked,
 *   and a request for them changes nothing, so typing somebody else's number
 *   cannot move their birthday. Correcting one is a back office job.
 * - an answer about offers is appended to the consent log like any other, with
 *   the wording the customer was shown, and can only ever be for the channel
 *   the member actually has a contact for.
 *
 * Lookups are exact. The back office search matches fragments, which on a
 * screen a customer types into would let a few letters fish for other people.
 */

import { z } from 'zod';
import { uuid, phone, email } from './primitives.js';
import { consentChannel } from './customers.js';

/** A phone or an email, never both and never neither. */
const oneContact = <T extends { phone?: string | undefined; email?: string | undefined }>(v: T) =>
  (v.phone !== undefined) !== (v.email !== undefined);

const contact = z
  .object({ phone: phone.optional(), email: email.optional() })
  .refine(oneContact, { message: 'send a phone or an email, one of the two', path: ['phone'] });

export const customerDisplayIdentifySchema = contact;
export const customerDisplayJoinSchema = contact;

/**
 * The longest each month can be. February is 29: a birthday has no year here,
 * so a leap day is a real birthday and has to be storable.
 */
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** How many days the month can have, or 0 for a month that does not exist. */
export function daysInBirthMonth(month: number): number {
  return Number.isInteger(month) && month >= 1 && month <= 12 ? MONTH_LENGTHS[month - 1]! : 0;
}

/** Whether a month and day name a day that exists in some year. */
export function isRealBirthday(month: number, day: number): boolean {
  return Number.isInteger(day) && day >= 1 && day <= daysInBirthMonth(month);
}

export const customerDisplayBirthdaySchema = z
  .object({
    birth_month: z.number().int().min(1).max(12),
    birth_day: z.number().int().min(1).max(31),
  })
  .refine((v) => isRealBirthday(v.birth_month, v.birth_day), {
    message: 'that month has no such day',
    path: ['birth_day'],
  });

/**
 * The customer's answer to "want offers?".
 *
 * `wording` is the question as it appeared on the screen, sent by the device
 * because the device is the only thing that knows what it showed. It goes
 * into the consent log's evidence: "they agreed" means little without "to
 * what", and the wording on that screen will change over the years.
 */
export const customerDisplayOffersSchema = z.object({
  channel: consentChannel,
  granted: z.boolean(),
  wording: z.string().trim().min(1).max(600),
});

/**
 * A member, as the customer's screen needs them.
 *
 * The contact fields are for the register, which attaches the customer to the
 * sale and shows the cashier who it is. The customer's own screen shows a
 * name and a balance and nothing else. No birthday comes back, only whether
 * one is missing: the screen has no reason to display one, and a number typed
 * by a stranger should not be answered with somebody's birthday.
 */
export const customerDisplayMemberSchema = z.object({
  customer: z.object({
    id: uuid,
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    phone: phone.nullable(),
    email: email.nullable(),
  }),
  /** True when this request created the member. */
  joined: z.boolean(),
  needs_birthday: z.boolean(),
  /**
   * The channel to ask about offers on, or null when there is nothing to ask:
   * it is the channel of the contact the customer just typed, and only if
   * they have never answered for it. A "no" is an answer and is not asked again.
   */
  ask_offers: consentChannel.nullable(),
  loyalty: z.object({
    program_name: z.string(),
    program_active: z.boolean(),
    points: z.number().int(),
    /** What the balance is worth when spent, in cents, as a digit string. */
    value_minor: z.string(),
  }),
});

export const customerDisplayIdentifyResultSchema = z.object({
  found: z.boolean(),
  member: customerDisplayMemberSchema.nullable(),
});

export const customerDisplaySavedSchema = z.object({ saved: z.boolean() });

export type CustomerDisplayContact = z.infer<typeof customerDisplayIdentifySchema>;
export type CustomerDisplayBirthday = z.infer<typeof customerDisplayBirthdaySchema>;
export type CustomerDisplayOffers = z.infer<typeof customerDisplayOffersSchema>;
export type CustomerDisplayMember = z.infer<typeof customerDisplayMemberSchema>;
export type CustomerDisplayIdentifyResult = z.infer<typeof customerDisplayIdentifyResultSchema>;
