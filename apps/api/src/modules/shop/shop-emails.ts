/**
 * The emails a customer receives, as plain text.
 *
 * Every one says which shop sent it and why, and none carries anything more
 * than the reason needs: no password, no full address, no card detail -- and
 * for a reset, a warning to ignore it if it was not them.
 */

import { ApiException } from '../../platform/errors/api-exception.js';

export interface EmailContent {
  subject: string;
  body: string;
}

/**
 * Where links in emails point.
 *
 * Required in production: a confirmation link to localhost would send every
 * customer nowhere. In development it defaults to the storefront's dev port.
 */
export function storefrontUrl(path: string): string {
  // `||`, not `??`: a copied env template leaves STOREFRONT_URL= empty, which means unset.
  const base = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3002');
  if (!base) {
    throw new ApiException('provider_unavailable', 'STOREFRONT_URL is not set, so emails cannot link to the website', {
      retryable: false,
    });
  }
  return `${base.replace(/\/+$/, '')}${path}`;
}

const signOff = (shop: string) => `\n\n— ${shop}`;

export function verifyEmailMessage(shop: string, token: string): EmailContent {
  return {
    subject: `Confirm your email for ${shop}`,
    body:
      `Confirm this is your email address to finish setting up your ${shop} account:\n\n` +
      `${storefrontUrl(`/account/verify?token=${encodeURIComponent(token)}`)}\n\n` +
      `The link works for 24 hours. If you didn't create an account, you can ignore this email and nothing will happen.` +
      signOff(shop),
  };
}

export function alreadyRegisteredMessage(shop: string): EmailContent {
  return {
    subject: `You already have a ${shop} account`,
    body:
      `Someone tried to create a ${shop} account with this email address, but there's already one.\n\n` +
      `If it was you, sign in here:\n${storefrontUrl('/account/sign-in')}\n\n` +
      `Forgotten your password? Reset it here:\n${storefrontUrl('/account/forgot-password')}\n\n` +
      `If it wasn't you, you don't need to do anything. Your account hasn't changed.` +
      signOff(shop),
  };
}

export function resetPasswordMessage(shop: string, token: string): EmailContent {
  return {
    subject: `Reset your ${shop} password`,
    body:
      `Use this link to choose a new password:\n\n` +
      `${storefrontUrl(`/account/reset-password?token=${encodeURIComponent(token)}`)}\n\n` +
      `The link works for one hour and only once. If you didn't ask to reset your password, ignore this email -- ` +
      `your password stays as it is.` +
      signOff(shop),
  };
}

export interface OrderEmailFacts {
  shop: string;
  firstName: string | null;
  orderNumber: string;
  trackingToken: string;
  totalMinor: string;
  storeName: string;
  storeAddress: string | null;
  storePhone: string | null;
  minimumAge: number | null;
  resolutionNote?: string | null;
  fulfilment: 'pickup' | 'delivery';
  /** Paid online with a test payment: nothing was really charged. */
  paymentSimulated?: boolean;
  /** The courier's own live tracking page, when it gave one. */
  courierTrackingUrl?: string | null;
  /** Taken by a simulated courier: nobody is really coming. */
  deliverySimulated?: boolean;
  pointsEarned?: number | null;
}

const greeting = (firstName: string | null) => (firstName ? `Hi ${firstName},\n\n` : 'Hi,\n\n');

function dollars(minor: string): string {
  const value = BigInt(minor);
  return `$${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function pickupFooter(facts: OrderEmailFacts): string {
  const lines = [`Pick up at ${facts.storeName}`];
  if (facts.storeAddress) lines.push(facts.storeAddress);
  if (facts.storePhone) lines.push(`Questions? Call ${facts.storePhone}.`);
  return `\n\n${lines.join('\n')}`;
}

function idReminder(facts: OrderEmailFacts): string {
  if (!facts.minimumAge) return '';
  return facts.fulfilment === 'delivery'
    ? `\n\nThe driver checks photo ID and asks for a signature. Someone ${facts.minimumAge} or older with a valid ID has to be there to take the order, or it goes back to the shop.`
    : `\n\nBring a valid photo ID. You must be ${facts.minimumAge} or older to collect this order, and we check ID at the counter.`;
}

function paymentLine(facts: OrderEmailFacts, when: 'placed' | 'ready' | 'delivered'): string {
  if (facts.fulfilment === 'pickup') {
    return when === 'placed' ? 'paid in store when you pick up' : 'paid in store';
  }
  const test = facts.paymentSimulated ? ' (a test payment: nothing was charged)' : '';
  return when === 'delivered' ? `charged to your card${test}` : `held on your card until it's delivered${test}`;
}

function deliveryNote(facts: OrderEmailFacts): string {
  return facts.deliverySimulated ? '\n\nThis shop is still testing delivery: no driver is really on the way.' : '';
}

export function orderPlacedMessage(facts: OrderEmailFacts): EmailContent {
  const next = facts.fulfilment === 'delivery' ? "when it's on its way" : "when it's ready to pick up";
  return {
    subject: `We got your order ${facts.orderNumber}`,
    body:
      greeting(facts.firstName) +
      `Thanks for your order. We'll email you again ${next}.\n\n` +
      `Order ${facts.orderNumber}\nTotal ${dollars(facts.totalMinor)}, ${paymentLine(facts, 'placed')}.\n\n` +
      `Track it here:\n${storefrontUrl(`/track/${facts.trackingToken}`)}` +
      idReminder(facts) +
      (facts.fulfilment === 'delivery' ? deliveryNote(facts) : pickupFooter(facts)) +
      signOff(facts.shop),
  };
}

export function orderOnItsWayMessage(facts: OrderEmailFacts): EmailContent {
  const tracking = facts.courierTrackingUrl ?? storefrontUrl(`/track/${facts.trackingToken}`);
  return {
    subject: `Your order ${facts.orderNumber} is on its way`,
    body:
      greeting(facts.firstName) +
      `Your order has left the shop with a DoorDash driver.\n\n` +
      `Follow it here:\n${tracking}` +
      idReminder(facts) +
      deliveryNote(facts) +
      signOff(facts.shop),
  };
}

export function orderDeliveredMessage(facts: OrderEmailFacts): EmailContent {
  const points = facts.pointsEarned ? `\n\nYou earned ${facts.pointsEarned} rewards points on this order.` : '';
  return {
    subject: `Your order ${facts.orderNumber} was delivered`,
    body:
      greeting(facts.firstName) +
      `Your order was delivered. Thanks for shopping with us.\n\n` +
      `Order ${facts.orderNumber}\nTotal ${dollars(facts.totalMinor)}, ${paymentLine(facts, 'delivered')}.` +
      points +
      signOff(facts.shop),
  };
}

export function orderDeliveryFailedMessage(facts: OrderEmailFacts): EmailContent {
  return {
    subject: `We couldn't deliver your order ${facts.orderNumber}`,
    body:
      greeting(facts.firstName) +
      `Sorry, your order ${facts.orderNumber} couldn't be delivered.` +
      (facts.resolutionNote ? `\n\n${facts.resolutionNote}` : '') +
      `\n\nThe order is going back to the shop, and nothing has been charged for it. We'll be in touch about sending it again or cancelling it.` +
      pickupFooter(facts) +
      signOff(facts.shop),
  };
}

export function orderReadyMessage(facts: OrderEmailFacts): EmailContent {
  return {
    subject: `Your order ${facts.orderNumber} is ready to pick up`,
    body:
      greeting(facts.firstName) +
      `Your order is ready. Come by whenever suits you.\n\n` +
      `Order ${facts.orderNumber}\nTotal ${dollars(facts.totalMinor)}, paid in store.\n\n` +
      `${storefrontUrl(`/track/${facts.trackingToken}`)}` +
      idReminder(facts) +
      pickupFooter(facts) +
      signOff(facts.shop),
  };
}

export function orderStoppedMessage(facts: OrderEmailFacts, kind: 'rejected' | 'cancelled'): EmailContent {
  const what = kind === 'rejected' ? "we couldn't accept" : 'we had to cancel';
  return {
    subject: `Your order ${facts.orderNumber} has been ${kind === 'rejected' ? 'declined' : 'cancelled'}`,
    body:
      greeting(facts.firstName) +
      `Sorry, ${what} your order ${facts.orderNumber}.` +
      (facts.resolutionNote ? `\n\n${facts.resolutionNote}` : '') +
      (facts.fulfilment === 'delivery'
        ? `\n\nNothing was charged. The payment held on your card has been released.`
        : `\n\nNothing was charged -- pickup orders are paid in store.`) +
      pickupFooter(facts) +
      signOff(facts.shop),
  };
}
