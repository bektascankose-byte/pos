/**
 * What the storefront and the API say to each other.
 *
 * Everything here is public-facing, which shapes it in two ways. It carries
 * less than the back-office contracts do: no cost, no exact stock count, no
 * staff names, no other customer's anything. And its words are a shopper's
 * words -- "only a few left", not a sellable quantity of 2.000.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';
import { orderFulfilmentSchema, orderStatusSchema } from './orders.js';
import { deliveryAddressSchema, usPostalCode } from './delivery.js';
import { loyaltyEntryKindSchema } from './loyalty.js';

/** Money off the wire: a digit string of minor units. */
const minor = z.string().regex(/^-?\d+$/, 'money must be a whole number of minor units');

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

/**
 * How much is left, in the only precision a shopper needs. An exact count
 * online is an invitation to wait for the last one, and a number that is
 * wrong a minute later.
 */
export const shopStockSchema = z.enum(['in_stock', 'low_stock', 'out_of_stock']);

export const shopHoursSchema = z.object({
  /** 0 is Sunday, as `store_hours` stores it. */
  day_of_week: z.number().int().min(0).max(6),
  opens_at: z.string(),
  closes_at: z.string(),
});

export const shopInfoSchema = z.object({
  shop_name: z.string(),
  store: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postal_code: z.string().nullable(),
    timezone: z.string(),
  }),
  /** Pickup hours if the shop set them separately, otherwise its opening hours. */
  hours: z.array(shopHoursSchema),
  /**
   * True on a server that is not sending real email. The storefront says so on
   * every page, so nobody waits for a confirmation that went to a folder.
   */
  test_mode: z.boolean(),
  delivery: z.object({
    /** Offered on the website: switched on by the shop, and a courier can be requested. */
    enabled: z.boolean(),
    /** Couriers are simulated on this server. Every delivery screen says so. */
    simulated: z.boolean(),
    provider_name: z.string(),
    postal_codes: z.array(z.string()),
    fee_minor: minor,
    free_over_minor: minor.nullable(),
    minimum_subtotal_minor: minor,
  }),
  /** Online payment is simulated on this server: no card is asked for and nothing is charged. */
  payments_simulated: z.boolean(),
  loyalty: z.object({ active: z.boolean(), name: z.string(), points_per_dollar: z.string() }),
});

export const shopCategorySchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  parent_id: uuid.nullable(),
  depth: z.number().int(),
  /** Products listed online in this category or any beneath it. */
  product_count: z.number().int(),
});

export const shopProductCardSchema = z.object({
  id: uuid,
  name: z.string(),
  brand: z.object({ id: uuid, name: z.string() }).nullable(),
  category: z.object({ id: uuid, slug: z.string(), name: z.string() }).nullable(),
  price_from_minor: minor,
  price_to_minor: minor,
  image_id: uuid.nullable(),
  stock: shopStockSchema,
  variant_count: z.number().int(),
  /** The age every item in this product needs, if any. Shown before anyone adds it to a cart. */
  minimum_age: z.number().int().nullable(),
});

export const shopProductListSchema = z.object({
  items: z.array(shopProductCardSchema),
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
});

export const shopVariantSchema = z.object({
  id: uuid,
  /** The variant's own name ("Blue Razz Ice"), or null for a product with one variant. */
  name: z.string().nullable(),
  attributes: z.record(z.string()),
  price_minor: minor,
  stock: shopStockSchema,
  /** The most one order may take, if the shop set a limit. Whole units. */
  max_per_order: z.number().int().nullable(),
  image_id: uuid.nullable(),
});

export const shopProductDetailSchema = shopProductCardSchema.extend({
  description: z.string().nullable(),
  images: z.array(z.object({ id: uuid, alt_text: z.string().nullable() })),
  variants: z.array(shopVariantSchema),
  /** Whether a photo ID is checked when it is collected. */
  id_required: z.boolean(),
});

export const shopSuggestionSchema = z.object({
  kind: z.enum(['product', 'brand', 'category']),
  id: uuid,
  label: z.string(),
  /** A second line: the brand for a product, a count for a brand or category. */
  detail: z.string().nullable(),
  /** The category's slug, for building its link. Null for the other kinds. */
  slug: z.string().nullable(),
});

// -----------------------------------------------------------------------------
// Cart
// -----------------------------------------------------------------------------

export const shopCartProblemSchema = z.enum([
  'not_available',
  'not_allowed',
  'out_of_stock',
  'not_enough_stock',
  'over_limit',
]);

export const shopCartLineSchema = z.object({
  variant_id: uuid,
  product_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  image_id: uuid.nullable(),
  quantity: z.number().int(),
  unit_price_minor: minor.nullable(),
  line_total_minor: minor.nullable(),
  problem: shopCartProblemSchema.nullable(),
  /** Written for the shopper: what is wrong and what to do about it. */
  problem_message: z.string().nullable(),
  /** The most this line can be raised to right now, if lower than the shop's usual maximum. */
  max_quantity: z.number().int(),
});

export const shopCartSchema = z.object({
  /** How this cart will be fulfilled. What may be sold, the fee and the tax all follow it. */
  fulfilment: orderFulfilmentSchema,
  /** The ZIP code the shopper gave for delivery, if any. */
  delivery_postal_code: z.string().nullable(),
  lines: z.array(shopCartLineSchema),
  item_count: z.number().int(),
  subtotal_minor: minor,
  /** Zero for pickup, and for delivery orders over the free-delivery line. */
  delivery_fee_minor: minor,
  /** Worked out the way the sale will be charged, including any tax on the delivery fee. */
  estimated_tax_minor: minor,
  estimated_total_minor: minor,
  /** Why this cart cannot be delivered where it is going, or null. Pickup carts are always null. */
  delivery_problem: z.string().nullable(),
  /** False while any line has a problem, or delivery is not possible. The checkout button follows it. */
  can_checkout: z.boolean(),
  minimum_age: z.number().int().nullable(),
  id_required: z.boolean(),
  /** Roughly what a signed-in customer will earn once the order is completed. Null for guests or with no program. */
  points_to_earn: z.number().int().nullable(),
});

export const shopSetFulfilmentSchema = z.object({
  fulfilment: orderFulfilmentSchema,
  postal_code: usPostalCode.optional(),
});

export const shopCartCreatedSchema = z.object({
  cart_token: z.string(),
  cart: shopCartSchema,
});

/** Set a line's quantity. Zero takes the line out. */
export const shopSetCartLineSchema = z.object({
  quantity: z.number().int().min(0).max(99),
});

// -----------------------------------------------------------------------------
// Checkout and tracking
// -----------------------------------------------------------------------------

export const shopCheckoutSchema = z.object({
  /** Required for a guest. A signed-in customer's own details are used instead. */
  contact: z
    .object({
      first_name: z.string().trim().min(1).max(100),
      last_name: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(320),
      phone: z.string().trim().max(32).optional(),
    })
    .optional(),
  note: z.string().trim().max(500).optional(),
  /**
   * The customer says they are old enough. Required, and recorded -- and
   * never mistaken for verification, which happens at the counter for pickup
   * and at the door for delivery.
   */
  age_attested: z.literal(true),
  /**
   * Required when the cart is for delivery. The date of birth is sent to the
   * age check and not kept: what is kept is that the check was done, how, and
   * what it said.
   */
  delivery: z
    .object({
      address: deliveryAddressSchema,
      /** Any common US format. The driver calls this number. */
      phone: z.string().trim().min(7).max(32),
      date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use the date picker'),
    })
    .optional(),
  /**
   * What the payment form produced, for orders paid online. A processor's
   * token, never a card number. On a server simulating payments the
   * storefront sends a test token instead.
   */
  payment_token: z.string().trim().min(1).max(500).optional(),
});

export const shopPlacedOrderSchema = z.object({
  order_number: z.string(),
  tracking_token: z.string(),
  status: orderStatusSchema,
});

export const shopTrackedOrderSchema = z.object({
  order_number: z.string(),
  status: orderStatusSchema,
  /** What the customer calls this status: "being prepared", "ready". */
  status_label: z.string(),
  fulfilment: orderFulfilmentSchema,
  first_name: z.string().nullable(),
  placed_at: timestamp,
  ready_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  cancelled_at: timestamp.nullable(),
  /** Why it was rejected or cancelled, in the shop's words. */
  resolution_note: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unit_price_minor: minor,
      line_total_minor: minor,
      removed: z.boolean(),
      removed_reason: z.string().nullable(),
    }),
  ),
  subtotal_minor: minor,
  delivery_fee_minor: minor,
  tax_minor: minor,
  total_minor: minor,
  /** Paid online, and in what state; null for an order paid at the counter. */
  payment: z.object({ status: z.string(), simulated: z.boolean() }).nullable(),
  /**
   * For a delivery, where it is going and how it is getting there. The street
   * address is not repeated: this page opens for anyone with the link.
   */
  delivery: z
    .object({
      city: z.string(),
      postal_code: z.string(),
      provider_name: z.string(),
      simulated: z.boolean(),
      tracking_url: z.string().nullable(),
      driver_first_name: z.string().nullable(),
      estimated_dropoff_at: timestamp.nullable(),
      dropped_off_at: timestamp.nullable(),
    })
    .nullable(),
  /** Points the order earned once it was completed, for a signed-in customer's order. */
  points_earned: z.number().int().nullable(),
  /** Whether the customer can still call it off themselves: only before the shop accepts it. */
  can_cancel: z.boolean(),
  events: z.array(z.object({ status: orderStatusSchema, label: z.string(), at: timestamp })),
  pickup: z.object({
    store_name: z.string(),
    address_line1: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    postal_code: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  minimum_age: z.number().int().nullable(),
  id_required: z.boolean(),
});

// -----------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------

/**
 * Length, and nothing else. Composition rules ("one symbol, one digit") make
 * passwords harder to remember without making them harder to guess, which is
 * why NIST dropped them; a long password is the strong one.
 */
export const shopPasswordSchema = z
  .string()
  .min(10, 'use at least 10 characters')
  .max(128, 'use at most 128 characters');

export const shopRegisterSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320),
  password: shopPasswordSchema,
  /** Ticked, never pre-ticked. Recorded only once the email address is confirmed. */
  marketing_email: z.boolean().default(false),
  age_attested: z.literal(true),
  /**
   * The number the shop's rewards know the customer by, if they have one. Not
   * put on the account yet: once the email is confirmed a code is texted to it,
   * and entering that code is what links the account to the rewards.
   */
  phone: z.string().trim().max(32).optional(),
});

export const shopSignInSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(128),
});

export const shopTokenSchema = z.object({ token: z.string().min(20).max(200) });

export const shopForgotPasswordSchema = z.object({ email: z.string().trim().email().max(320) });

export const shopResetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: shopPasswordSchema,
});

export const shopChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: shopPasswordSchema,
});

/** Names only. A phone number is changed by proving it, with `shopRequestPhoneCodeSchema`. */
export const shopUpdateProfileSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
});

/** Ask for a code to be texted to a phone number. */
export const shopRequestPhoneCodeSchema = z.object({ phone: z.string().trim().min(7).max(32) });

/** The six digits that were texted. */
export const shopConfirmPhoneCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'enter the 6-digit code'),
});

export const shopPhoneCodeSentSchema = z.object({
  status: z.literal('code_sent'),
  /** "ending in 0123" -- which phone to look at, without repeating the number. */
  phone_hint: z.string(),
  expires_in_seconds: z.number().int(),
});

/**
 * Email only. Promotional text messages for this category are filtered by the
 * carriers regardless of consent (see `MessagingService`), so asking for an SMS
 * opt-in would be collecting a permission nothing can use.
 */
export const shopConsentsSchema = z.object({ marketing_email: z.boolean() });

export const shopCustomerProfileSchema = z.object({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  /** Whether the phone above is the one the customer proved with a texted code. */
  phone_verified: z.boolean(),
  marketing_email: z.boolean(),
  /** A rewards phone given at sign-up that still needs its code. Shown as a hint only. */
  pending_phone_hint: z.string().nullable(),
});

/** A customer's rewards, as they see them on the website. */
export const shopRewardsSchema = z.object({
  program_name: z.string(),
  active: z.boolean(),
  points: z.number().int(),
  lifetime_earned: z.number().int(),
  points_per_dollar: z.string(),
  /** What the balance is worth when spent in store, in cents. */
  value_minor: minor,
  phone: z.string().nullable(),
  phone_verified: z.boolean(),
  activity: z.array(
    z.object({
      kind: loyaltyEntryKindSchema,
      points: z.number().int(),
      /** "In store, receipt HH01-R1-004173", "Online order HH01-260916-001", or the note of an adjustment. */
      label: z.string(),
      at: timestamp,
    }),
  ),
});

/** What confirming a phone code did. */
export const shopPhoneVerifiedSchema = z.object({
  status: z.literal('verified'),
  /** True when the phone belonged to an in-store rewards member and the account has now become that member. */
  linked_in_store_rewards: z.boolean(),
  rewards: shopRewardsSchema,
});

export const shopSessionSchema = z.object({
  session_token: z.string(),
  expires_at: timestamp,
  customer: shopCustomerProfileSchema,
});

/** Anything that sends an email answers the same way, whether or not the account exists. */
export const shopAcceptedSchema = z.object({ status: z.literal('check_email') });

export const shopCustomerOrderSchema = z.object({
  order_number: z.string(),
  tracking_token: z.string(),
  status: orderStatusSchema,
  status_label: z.string(),
  placed_at: timestamp,
  total_minor: minor,
  item_count: z.number().int(),
});

export type ShopStock = z.infer<typeof shopStockSchema>;
export type ShopHours = z.infer<typeof shopHoursSchema>;
export type ShopInfo = z.infer<typeof shopInfoSchema>;
export type ShopCategory = z.infer<typeof shopCategorySchema>;
export type ShopProductCard = z.infer<typeof shopProductCardSchema>;
export type ShopProductList = z.infer<typeof shopProductListSchema>;
export type ShopVariant = z.infer<typeof shopVariantSchema>;
export type ShopProductDetail = z.infer<typeof shopProductDetailSchema>;
export type ShopSuggestion = z.infer<typeof shopSuggestionSchema>;
export type ShopCartProblem = z.infer<typeof shopCartProblemSchema>;
export type ShopCartLine = z.infer<typeof shopCartLineSchema>;
export type ShopCart = z.infer<typeof shopCartSchema>;
export type ShopCartCreated = z.infer<typeof shopCartCreatedSchema>;
export type ShopCheckout = z.infer<typeof shopCheckoutSchema>;
export type ShopPlacedOrder = z.infer<typeof shopPlacedOrderSchema>;
export type ShopTrackedOrder = z.infer<typeof shopTrackedOrderSchema>;
export type ShopRegister = z.infer<typeof shopRegisterSchema>;
export type ShopCustomerProfile = z.infer<typeof shopCustomerProfileSchema>;
export type ShopSession = z.infer<typeof shopSessionSchema>;
export type ShopCustomerOrder = z.infer<typeof shopCustomerOrderSchema>;
export type ShopSetFulfilment = z.infer<typeof shopSetFulfilmentSchema>;
export type ShopRewards = z.infer<typeof shopRewardsSchema>;
export type ShopPhoneCodeSent = z.infer<typeof shopPhoneCodeSentSchema>;
export type ShopPhoneVerified = z.infer<typeof shopPhoneVerifiedSchema>;
