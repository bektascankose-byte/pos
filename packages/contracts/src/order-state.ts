/**
 * The order state machine.
 *
 * Kept here, pure and data-driven, rather than as `if` statements inside the
 * service, for two reasons. It is testable without a database — every
 * transition and, more importantly, every *non*-transition. And it is the one
 * description of the lifecycle, so the POS, the storefront and the customer's
 * tracking page cannot each grow their own slightly different idea of what
 * happens next.
 *
 * The rule the whole thing exists to enforce: **an impossible state change is
 * refused, not tolerated.** A courier webhook arriving out of order, a staff
 * member double-tapping Ready, a retried request — each of those tries to move
 * an order somewhere it cannot go, and every one of them is a real thing that
 * happens weekly rather than a hypothetical.
 */

/**
 * Every status, in the order the `order_status` database enum declares them.
 *
 * The one list. The type below and the wire schema in `orders.ts` are both
 * derived from it, and the database test pins the enum to the same values, so
 * a status cannot be added in one place and forgotten in another.
 */
export const ORDER_STATUSES = [
  'placed',
  'accepted',
  'preparing',
  'ready',
  'completed',
  'rejected',
  'cancelled',
  'pending_payment',
  'payment_failed',
  'courier_requested',
  'in_transit',
  'delivery_failed',
  'returned_to_store',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_FULFILMENTS = ['pickup', 'delivery'] as const;

export type OrderFulfilment = (typeof ORDER_FULFILMENTS)[number];

/**
 * Where an order may go from where it is.
 *
 * Deliberately not symmetric and deliberately sparse. Anything absent is
 * refused, which is why adding a status to the enum without adding it here
 * makes it unreachable rather than quietly reachable from everywhere.
 *
 * `pending_payment` and the courier statuses have no outbound edges yet: they
 * are declared so the vocabulary is complete, and they stay unreachable until
 * the phase that earns them.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  placed: ['accepted', 'rejected', 'cancelled'],
  // Preparing is optional. A small shop with the item already on the shelf goes
  // straight to ready, and forcing a click nobody needs is how staff stop using
  // the screen and start phoning each other.
  accepted: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  // Pickup completes at the counter. Delivery leaves for a courier, which is
  // why `ready` has more than one way out and the caller must say which.
  ready: ['completed', 'courier_requested', 'cancelled'],
  courier_requested: ['in_transit', 'delivery_failed', 'cancelled'],
  in_transit: ['completed', 'delivery_failed'],
  delivery_failed: ['returned_to_store', 'ready'],
  returned_to_store: ['ready', 'cancelled'],
  pending_payment: ['placed', 'payment_failed', 'cancelled'],
  payment_failed: ['pending_payment', 'cancelled'],
  // Terminal. An order that has been handed over, refused or called off does
  // not come back -- a correction is a refund or a new order, both of which
  // leave a record of themselves.
  completed: [],
  rejected: [],
  cancelled: [],
};

/** True when `to` is reachable from `from` in one step. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** Nothing more will happen to an order in one of these. */
export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status]?.length === 0;
}

/**
 * Whether reaching this status means goods have left the shop.
 *
 * The single fact the inventory ledger hangs off: stock moves at completion
 * and at no other moment, so this is what decides when a sale is written.
 */
export function movesStock(to: OrderStatus): boolean {
  return to === 'completed';
}

/**
 * Whether an order in this status is still holding its claim on stock.
 *
 * Distinct from `movesStock`. Between placement and completion an order claims
 * inventory without having moved it, and anything that ends the order releases
 * that claim -- which for pickup means only that availability recovers, since
 * pickup takes no reservation in this build.
 */
export function holdsClaim(status: OrderStatus): boolean {
  return !isTerminal(status);
}

export class InvalidOrderTransition extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(
      nextStatuses(from).length === 0
        ? `This order is already ${readableStatus(from)} and cannot change again.`
        : `An order that is ${readableStatus(from)} cannot become ${readableStatus(to)}. ` +
          `It can only become: ${nextStatuses(from).map(readableStatus).join(', ')}.`,
    );
    this.name = 'InvalidOrderTransition';
  }
}

/** Throws rather than returning false, for the call sites where carrying on would be wrong. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidOrderTransition(from, to);
}

/** What a person calls this status. Used in errors staff and customers both read. */
export function readableStatus(status: OrderStatus): string {
  switch (status) {
    case 'placed': return 'new';
    case 'accepted': return 'accepted';
    case 'preparing': return 'being prepared';
    case 'ready': return 'ready';
    case 'completed': return 'completed';
    case 'rejected': return 'rejected';
    case 'cancelled': return 'cancelled';
    case 'pending_payment': return 'awaiting payment';
    case 'payment_failed': return 'payment failed';
    case 'courier_requested': return 'waiting for a courier';
    case 'in_transit': return 'on its way';
    case 'delivery_failed': return 'delivery failed';
    case 'returned_to_store': return 'returned to the shop';
  }
}
