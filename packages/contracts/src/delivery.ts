/**
 * Local delivery: where a shop delivers, what it charges, and how a courier's
 * reports move an order along.
 *
 * The courier is DoorDash Drive. Its reports arrive as webhooks, and webhooks
 * arrive late, twice, or not at all -- a "delivered" can turn up for an order
 * whose "picked up" never came. `courierSteps` is where that is absorbed: it
 * says which order statuses a report walks through from wherever the order
 * actually is, so a missing report never leaves an order stuck and a repeated
 * one never moves it twice.
 */

import { z } from 'zod';
import { timestamp } from './primitives.js';
import type { OrderFulfilment, OrderStatus } from './order-state.js';

/** Money off the wire: a digit string of minor units. */
const minor = z.string().regex(/^-?\d+$/, 'money must be a whole number of minor units');
/** Money onto the wire: a non-negative digit string of minor units. */
const minorIn = z.string().regex(/^\d{1,9}$/, 'a whole number of cents');

/**
 * The warning federal rules require on advertising for nicotine products, word
 * for word, capitals and punctuation included. Never paraphrased.
 */
export const NICOTINE_WARNING = 'WARNING: This product contains nicotine. Nicotine is an addictive chemical.';

export const usPostalCode = z.string().trim().regex(/^\d{5}$/, 'use a 5-digit ZIP code');

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

/** How couriers are requested on this server. */
export const courierModeSchema = z.enum([
  /** DoorDash is really called. */
  'live',
  /** No DoorDash credentials: deliveries are simulated, and every screen says so. */
  'simulated',
  /** A production server without credentials. Delivery cannot be offered at all. */
  'unavailable',
]);

export const deliverySettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  postal_codes: z.array(z.string()),
  fee_minor: minor,
  free_over_minor: minor.nullable(),
  minimum_subtotal_minor: minor,
  last_order_minutes_before_close: z.number().int(),
  pickup_instructions: z.string().nullable(),
  courier_mode: courierModeSchema,
  /** What still stops real deliveries, in plain words. Empty when nothing does. */
  problems: z.array(z.string()),
  updated_at: timestamp.nullable(),
});

export const updateDeliverySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  postal_codes: z.array(usPostalCode).max(200).optional(),
  fee_minor: minorIn.optional(),
  free_over_minor: minorIn.nullable().optional(),
  minimum_subtotal_minor: minorIn.optional(),
  last_order_minutes_before_close: z.number().int().min(0).max(240).optional(),
  pickup_instructions: z.string().trim().max(500).nullable().optional(),
});

/** Where a delivery goes. US addresses: the shop delivers locally. */
export const deliveryAddressSchema = z.object({
  address_line1: z.string().trim().min(3, 'enter the street address').max(200),
  address_line2: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2, 'enter the city').max(100),
  region: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'use the two-letter state code')
    .transform((value) => value.toUpperCase()),
  postal_code: usPostalCode,
  /** "Gate code 1234", "Blue door at the back". Read by the driver. */
  dropoff_instructions: z.string().trim().max(300).optional(),
});

// -----------------------------------------------------------------------------
// The arithmetic
// -----------------------------------------------------------------------------

export interface DeliveryTerms {
  postal_codes: readonly string[];
  fee_minor: bigint;
  free_over_minor: bigint | null;
  minimum_subtotal_minor: bigint;
}

/** What the customer pays for delivery on a basket of this size. */
export function deliveryFeeFor(terms: DeliveryTerms, subtotalMinor: bigint): bigint {
  if (terms.free_over_minor !== null && subtotalMinor >= terms.free_over_minor) return 0n;
  return terms.fee_minor;
}

/**
 * Why this basket cannot be delivered to this ZIP code, in the customer's
 * words -- or null when it can.
 */
export function deliveryRefusal(terms: DeliveryTerms, postalCode: string | null, subtotalMinor: bigint): string | null {
  if (!postalCode) return 'Enter your ZIP code to see if we deliver to you.';
  if (!terms.postal_codes.includes(postalCode)) return `We don't deliver to ${postalCode} yet. Pickup is available.`;
  if (subtotalMinor < terms.minimum_subtotal_minor) {
    const dollars = (Number(terms.minimum_subtotal_minor) / 100).toFixed(2);
    return `Delivery orders start at $${dollars}. Add a little more, or choose pickup.`;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Courier reports
// -----------------------------------------------------------------------------

/** What a courier can report, in this system's words rather than any one courier's. */
export const COURIER_EVENTS = [
  'driver_assigned',
  'arrived_at_store',
  'picked_up',
  'arrived_at_customer',
  'delivered',
  'cancelled',
  'returning',
  'returned',
] as const;

export type CourierEvent = (typeof COURIER_EVENTS)[number];

/**
 * The order statuses a courier report walks the order through, in order,
 * starting from where the order is now. Empty when the report changes nothing
 * about the order -- including a report repeated after it already took effect.
 *
 * Every step is a transition `order-state.ts` allows, so walking them one at a
 * time through the ordinary transition code keeps every rule it enforces.
 */
export function courierSteps(event: CourierEvent, current: OrderStatus): OrderStatus[] {
  switch (event) {
    case 'picked_up':
      return current === 'courier_requested' ? ['in_transit'] : [];
    case 'delivered':
      if (current === 'courier_requested') return ['in_transit', 'completed'];
      return current === 'in_transit' ? ['completed'] : [];
    case 'cancelled':
    case 'returning':
      return current === 'courier_requested' || current === 'in_transit' ? ['delivery_failed'] : [];
    case 'returned':
      if (current === 'courier_requested' || current === 'in_transit') return ['delivery_failed', 'returned_to_store'];
      return current === 'delivery_failed' ? ['returned_to_store'] : [];
    case 'driver_assigned':
    case 'arrived_at_store':
    case 'arrived_at_customer':
      return [];
  }
}

/** DoorDash Drive's webhook `event_name`, as a courier event, or null for one this system does not act on. */
export function doordashCourierEvent(eventName: string): CourierEvent | null {
  switch (eventName) {
    case 'DASHER_CONFIRMED':
      return 'driver_assigned';
    case 'DASHER_CONFIRMED_PICKUP_ARRIVAL':
      return 'arrived_at_store';
    case 'DASHER_PICKED_UP':
      return 'picked_up';
    case 'DASHER_CONFIRMED_DROPOFF_ARRIVAL':
      return 'arrived_at_customer';
    case 'DASHER_DROPPED_OFF':
      return 'delivered';
    case 'DELIVERY_CANCELLED':
      return 'cancelled';
    case 'DELIVERY_RETURN_INITIALIZED':
      return 'returning';
    case 'DELIVERY_RETURNED':
      return 'returned';
    default:
      return null;
  }
}

/** What a customer calls each status, which depends on whether the order is coming to them. */
export function customerOrderStatusLabel(status: OrderStatus, fulfilment: OrderFulfilment): string {
  switch (status) {
    case 'placed':
      return 'Received';
    case 'accepted':
      return 'Accepted';
    case 'preparing':
      return 'Being prepared';
    case 'ready':
      return fulfilment === 'delivery' ? 'Packed' : 'Ready for pickup';
    case 'completed':
      return fulfilment === 'delivery' ? 'Delivered' : 'Picked up';
    case 'rejected':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
    case 'pending_payment':
      return 'Awaiting payment';
    case 'payment_failed':
      return 'Payment failed';
    case 'courier_requested':
      return 'Finding a driver';
    case 'in_transit':
      return 'On its way';
    case 'delivery_failed':
      return "Couldn't be delivered";
    case 'returned_to_store':
      return 'Returned to the shop';
  }
}

// -----------------------------------------------------------------------------
// Staff views
// -----------------------------------------------------------------------------

export const orderDeliverySchema = z.object({
  provider: z.string(),
  recipient_name: z.string(),
  recipient_phone: z.string(),
  address_line1: z.string(),
  address_line2: z.string().nullable(),
  city: z.string(),
  region: z.string(),
  postal_code: z.string(),
  dropoff_instructions: z.string().nullable(),
  external_delivery_id: z.string().nullable(),
  provider_status: z.string().nullable(),
  tracking_url: z.string().nullable(),
  support_reference: z.string().nullable(),
  driver_first_name: z.string().nullable(),
  courier_fee_minor: minor.nullable(),
  requested_at: timestamp.nullable(),
  estimated_pickup_at: timestamp.nullable(),
  estimated_dropoff_at: timestamp.nullable(),
  picked_up_at: timestamp.nullable(),
  dropped_off_at: timestamp.nullable(),
  cancellation_reason: z.string().nullable(),
});

export const orderPaymentSchema = z.object({
  provider: z.string(),
  status: z.enum(['authorized', 'captured', 'voided', 'failed', 'refunded']),
  amount_minor: minor,
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  /** True when no real card was involved: a test payment on a server without a processor. */
  test: z.boolean(),
});

/** A courier report typed in by hand on a server simulating deliveries. */
export const simulateCourierEventSchema = z.object({
  event: z.enum(['picked_up', 'delivered', 'returning', 'returned', 'cancelled']),
});

export type CourierMode = z.infer<typeof courierModeSchema>;
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export type UpdateDeliverySettings = z.infer<typeof updateDeliverySettingsSchema>;
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;
export type OrderDelivery = z.infer<typeof orderDeliverySchema>;
export type OrderPayment = z.infer<typeof orderPaymentSchema>;
