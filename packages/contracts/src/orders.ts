/**
 * What the orders endpoints return.
 *
 * The lifecycle itself lives in `order-state.ts` -- this file is only the
 * shapes that cross the wire, so the back office and (later) the storefront
 * read the same record rather than each inferring one from a sample response.
 *
 * Two shapes rather than one, deliberately. The queue is what a person working
 * the counter needs at a glance and nothing more; the detail is everything,
 * including the timeline. Sending the detail for every row would put every
 * customer's contact details on a screen that is showing ten orders at once.
 */

import { z } from 'zod';
import { uuid, timestamp, quantity } from './primitives.js';
import { ORDER_FULFILMENTS, ORDER_STATUSES } from './order-state.js';

/**
 * Money as it comes off the wire: a digit string of minor units.
 *
 * Not `moneyNonNegative`, which is the *write* side -- it transforms a string
 * into a branded bigint for arithmetic. These schemas describe a response, and
 * a response carries the string. `reports.ts` makes the same distinction.
 */
const minor = z.string().regex(/^-?\d+$/, 'money must be a whole number of minor units');

export const orderFulfilmentSchema = z.enum(ORDER_FULFILMENTS);

export const orderStatusSchema = z.enum(ORDER_STATUSES);

/** One row of the counter's queue. */
export const orderQueueEntrySchema = z.object({
  id: uuid,
  order_number: z.string(),
  fulfilment: orderFulfilmentSchema,
  status: orderStatusSchema,
  total_minor: minor,
  placed_at: timestamp,
  accepted_at: timestamp.nullable(),
  ready_at: timestamp.nullable(),
  pickup_from: timestamp.nullable(),
  pickup_to: timestamp.nullable(),
  note: z.string().nullable(),
  customer_name: z.string().nullable(),
  line_count: z.number().int(),
  /**
   * How long it has been waiting. Sent as a number rather than left to the
   * browser to work out from `placed_at`, because a shop manages its queue by
   * this figure and a device with a wrong clock would show the wrong one.
   */
  waiting_seconds: z.number().int(),
});

export const orderLineSchema = z.object({
  id: uuid,
  variant_id: uuid,
  quantity,
  unit_price_minor: minor,
  line_total_minor: minor,
  description: z.string(),
  upc_snapshot: z.string(),
  /** Set when staff could not fill this line. The line stays; it is not deleted. */
  removed_at: timestamp.nullable(),
  removed_reason: z.string().nullable(),
});

/** One entry in the order's timeline. Append only, so nothing here is editable. */
export const orderEventSchema = z.object({
  from_status: orderStatusSchema.nullable(),
  to_status: orderStatusSchema,
  actor_type: z.string(),
  reason: z.string().nullable(),
  created_at: timestamp,
});

export const orderSchema = z.object({
  id: uuid,
  store_id: uuid,
  order_number: z.string(),
  customer_id: uuid.nullable(),
  customer_name: z.string().nullable(),
  guest_name: z.string().nullable(),
  guest_email: z.string().nullable(),
  guest_phone: z.string().nullable(),
  fulfilment: orderFulfilmentSchema,
  status: orderStatusSchema,
  subtotal_minor: minor,
  discount_minor: minor,
  tax_minor: minor,
  delivery_fee_minor: minor,
  total_minor: minor,
  pickup_from: timestamp.nullable(),
  pickup_to: timestamp.nullable(),
  note: z.string().nullable(),
  resolution_note: z.string().nullable(),
  /** Null until handoff. That nullness is the honest answer to "has this moved stock yet". */
  sale_id: uuid.nullable(),
  placed_at: timestamp,
  accepted_at: timestamp.nullable(),
  ready_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  cancelled_at: timestamp.nullable(),
  lines: z.array(orderLineSchema),
  events: z.array(orderEventSchema),
});

export type OrderQueueEntry = z.infer<typeof orderQueueEntrySchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type OrderEvent = z.infer<typeof orderEventSchema>;
export type Order = z.infer<typeof orderSchema>;
