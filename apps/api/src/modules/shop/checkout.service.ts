import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  customerOrderStatusLabel,
  deliveryRefusal,
  normalizeUsPhone,
  type OrderStatus,
  type ShopCheckout,
  type ShopPlacedOrder,
  type ShopTrackedOrder,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';
import { PaymentsService, type PaymentAuthorization } from '../../platform/payments/payments.service.js';
import { AgeVerificationService } from '../../platform/age-verification/age-verification.service.js';
import { CourierService } from '../../platform/couriers/courier.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { DeliverySettingsService } from '../delivery/delivery-settings.service.js';
import { CartsService } from './carts.service.js';
import type { CustomerSession } from './customer-sessions.service.js';
import { TrackingTokens } from './tracking-tokens.js';

/** What a customer calls each status. Kept for callers that only know the status; see `customerOrderStatusLabel`. */
export function customerStatusLabel(status: OrderStatus): string {
  return customerOrderStatusLabel(status, 'pickup');
}

/**
 * Turning a cart into an order, and showing the customer where it has got to.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly orders: OrdersService,
    private readonly carts: CartsService,
    private readonly tokens: TrackingTokens,
    private readonly delivery: DeliverySettingsService,
    private readonly payments: PaymentsService,
    private readonly ages: AgeVerificationService,
    private readonly couriers: CourierService,
  ) {}

  /**
   * Place the order a cart describes.
   *
   * The cart row is locked for the whole of it and marked with the order it
   * became, in the same transaction that writes the order. A second submit --
   * a double click, a refresh, a retry after a dropped connection -- waits on
   * that lock, finds the cart already converted, and is handed back the same
   * order. That is the whole of the duplicate protection, and it does not
   * depend on the browser behaving.
   *
   * A delivery order does two things first, outside that transaction, because
   * both talk to outside services: it checks the buyer's age, and it holds the
   * money for the order on the customer's card. A hold that ends up unused --
   * the transaction failed, or a double click found the order already placed --
   * is released before this returns.
   */
  async checkout(
    shop: ShopClient,
    cartToken: string | undefined,
    session: CustomerSession | null,
    input: ShopCheckout,
  ): Promise<ShopPlacedOrder> {
    const preview = await this.db.withOrg(shop.orgId, async (tx) => {
      const cart = await this.carts.lockTx(tx, shop, cartToken);
      return { cart, view: await this.carts.viewTx(tx, cart, session), contact: await this.contactTx(tx, session, input) };
    });

    let hold: PaymentAuthorization | null = null;
    let deliveryDetails: DeliveryDetails | null = null;

    if (preview.cart.fulfilment === 'delivery' && !preview.cart.converted_order_id) {
      deliveryDetails = await this.prepareDelivery(shop, preview, input);
      hold = deliveryDetails.hold;
    }

    let outcome: { order: Awaited<ReturnType<OrdersService['loadTx']>>; usedHold: boolean } | { refusal: string };
    try {
      outcome = await this.db.withOrg(shop.orgId, async (tx) => {
        const cart = await this.carts.lockTx(tx, shop, cartToken);

        if (cart.converted_order_id) {
          return { order: await this.orders.loadTx(tx, cart.converted_order_id), usedHold: false };
        }
        if (cart.customer_id && cart.customer_id !== session?.customerId) {
          // Somebody else's cart, reached with a copied token after they signed out.
          throw ApiException.notFound('cart');
        }
        if (cart.fulfilment !== preview.cart.fulfilment) {
          throw new ApiException('conflict', 'Pickup or delivery changed while you were checking out. Review your order.', {
            retryable: false,
          });
        }

        const lines = await this.carts.linesTx(tx, cart.id);
        if (lines.length === 0) {
          throw new ApiException('validation_failed', 'Your cart is empty.', { retryable: false });
        }

        const contact = await this.contactTx(tx, session, input);
        const placed = await this.orders.placeTx(tx, {
          store_id: cart.store_id,
          fulfilment: cart.fulfilment,
          ...contact.order,
          lines: lines.map((line) => ({ variant_id: line.variant_id, quantity: line.quantity })),
          note: input.note || undefined,
          placed_via: 'storefront',
          age_attested_at: new Date().toISOString(),
          ...(deliveryDetails
            ? {
                delivery: {
                  provider: this.couriers.courier().name,
                  recipient_name: contact.fullName,
                  recipient_phone: deliveryDetails.phone,
                  address_line1: deliveryDetails.address.address_line1,
                  address_line2: deliveryDetails.address.address_line2,
                  city: deliveryDetails.address.city,
                  region: deliveryDetails.address.region,
                  postal_code: deliveryDetails.address.postal_code,
                  dropoff_instructions: deliveryDetails.address.dropoff_instructions,
                },
                delivery_fee_minor: deliveryDetails.feeMinor.toString(),
              }
            : {}),
        });

        // A refusal is committed along with its compliance record, and the cart
        // stays as it was so the shopper can take the item out and try again.
        if ('refusal' in placed) return placed;

        if (deliveryDetails && hold) {
          if (placed.order.total_minor !== deliveryDetails.amountMinor.toString()) {
            // A price or stock change between showing the total and placing
            // the order. Nothing is charged for a total the customer did not see.
            throw new ApiException('conflict', 'Your total changed while you were checking out. Review your order and try again.', {
              retryable: false,
            });
          }
          await tx.query(
            `INSERT INTO order_payments
               (org_id, order_id, provider, provider_reference, amount_minor, status, card_brand, card_last4, authorized_at)
             VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, 'authorized', $5, $6, now())`,
            [placed.order.id, hold.provider, hold.reference, deliveryDetails.amountMinor.toString(), hold.cardBrand, hold.cardLast4],
          );
          if (deliveryDetails.ageCheck) {
            await tx.query(
              `UPDATE age_verifications SET order_id = $1 WHERE provider_token = $2 AND order_id IS NULL`,
              [placed.order.id, deliveryDetails.ageCheck],
            );
          }
        }

        await tx.query(`UPDATE carts SET converted_order_id = $1 WHERE id = $2`, [placed.order.id, cart.id]);
        return { order: placed.order, usedHold: true };
      });
    } catch (e) {
      if (hold?.approved) await this.release(hold);
      throw e;
    }

    if ('refusal' in outcome) {
      if (hold?.approved) await this.release(hold);
      throw new ApiException('validation_failed', outcome.refusal, { retryable: false });
    }
    if (hold?.approved && !outcome.usedHold) await this.release(hold);

    return {
      order_number: outcome.order.order_number,
      tracking_token: this.tokens.sign(shop.orgId, outcome.order.id),
      status: outcome.order.status,
    };
  }

  /** The order a tracking link names, as its customer should see it. */
  async track(shop: ShopClient, token: string): Promise<ShopTrackedOrder> {
    const orderId = this.tokens.verify(shop.orgId, token);
    if (!orderId) throw ApiException.notFound('order');

    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows: owners } = await tx.query<{ store_id: string }>(`SELECT store_id FROM orders WHERE id = $1`, [
        orderId,
      ]);
      if (owners[0]?.store_id !== shop.storeId) throw ApiException.notFound('order');

      const order = await this.orders.loadTx(tx, orderId);
      const { rows: people } = await tx.query<{ first_name: string | null }>(
        `SELECT c.first_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
        [orderId],
      );
      const { rows: stores } = await tx.query<ShopTrackedOrder['pickup']>(
        `SELECT name AS store_name, address_line1, city, region, postal_code, phone FROM stores WHERE id = $1`,
        [order.store_id],
      );
      const { rows: points } = await tx.query<{ points: number }>(
        `SELECT points FROM loyalty_ledger WHERE sale_id = $1 AND kind = 'earn'`,
        [order.sale_id],
      );

      return {
        order_number: order.order_number,
        status: order.status,
        status_label: customerOrderStatusLabel(order.status, order.fulfilment),
        fulfilment: order.fulfilment,
        // The first name only. The link can be forwarded, and a surname or a
        // phone number on a page anyone with the link can open is more than
        // "your order is ready" needs.
        first_name: people[0]?.first_name ?? order.guest_name?.split(' ')[0] ?? null,
        placed_at: order.placed_at,
        ready_at: order.ready_at,
        completed_at: order.completed_at,
        cancelled_at: order.cancelled_at,
        resolution_note: order.resolution_note,
        lines: order.lines.map((line) => ({
          description: line.description,
          quantity: Number(line.quantity),
          unit_price_minor: line.unit_price_minor,
          line_total_minor: line.line_total_minor,
          removed: line.removed_at !== null,
          removed_reason: line.removed_reason,
        })),
        subtotal_minor: order.subtotal_minor,
        delivery_fee_minor: order.delivery_fee_minor,
        tax_minor: order.tax_minor,
        total_minor: order.total_minor,
        payment: order.payment ? { status: order.payment.status, simulated: order.payment.test } : null,
        delivery: order.delivery
          ? {
              city: order.delivery.city,
              postal_code: order.delivery.postal_code,
              provider_name: 'DoorDash',
              simulated: order.delivery.provider === 'simulated',
              tracking_url: order.delivery.tracking_url,
              driver_first_name: order.delivery.driver_first_name,
              estimated_dropoff_at: order.delivery.estimated_dropoff_at,
              dropped_off_at: order.delivery.dropped_off_at,
            }
          : null,
        points_earned: points[0]?.points ?? null,
        can_cancel: order.status === 'placed',
        events: order.events.map((event) => ({
          status: event.to_status,
          label: customerOrderStatusLabel(event.to_status, order.fulfilment),
          at: event.created_at,
        })),
        pickup: stores[0]!,
        minimum_age: order.minimum_age,
        id_required: order.id_required,
      };
    });
  }

  /**
   * The customer calls the order off themselves.
   *
   * Only before the shop has accepted it. After that someone may already be
   * picking it, and the right way to cancel is to ring the shop -- which the
   * page says, rather than offering a button that would pull the order out
   * from under a person holding it. Money held for a delivery goes back.
   */
  async cancel(shop: ShopClient, token: string): Promise<ShopTrackedOrder> {
    const orderId = this.tokens.verify(shop.orgId, token);
    if (!orderId) throw ApiException.notFound('order');

    await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ store_id: string; status: OrderStatus }>(
        `SELECT store_id, status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = rows[0];
      if (!order || order.store_id !== shop.storeId) throw ApiException.notFound('order');
      if (order.status !== 'placed') {
        throw new ApiException(
          'conflict',
          'The shop has already started on this order. Call the shop to cancel it.',
          { retryable: false },
        );
      }
      await this.orders.transitionTx(tx, null, orderId, 'cancelled', {
        reason: 'Cancelled by the customer.',
        actorType: 'customer',
      });
    });

    return this.track(shop, token);
  }

  // ------------------------------------------------------------------ private

  /**
   * Everything a delivery order needs before it can be placed: the address is
   * one the shop delivers to, the buyer is old enough, and the money is held.
   * In that order, so a refused age check never touches a card.
   */
  private async prepareDelivery(
    shop: ShopClient,
    preview: { cart: { store_id: string }; view: Awaited<ReturnType<CartsService['viewTx']>>; contact: Contact },
    input: ShopCheckout,
  ): Promise<DeliveryDetails> {
    if (!input.delivery) {
      throw new ApiException('validation_failed', 'Enter the delivery address.', { retryable: false });
    }
    const phone = normalizeUsPhone(input.delivery.phone);
    if (!phone) {
      throw new ApiException('validation_failed', 'Enter a US mobile number the driver can call.', { retryable: false });
    }
    if (!preview.view.can_checkout) {
      throw new ApiException(
        'conflict',
        preview.view.delivery_problem ?? 'Something in your cart needs attention before you can check out.',
        { retryable: false },
      );
    }

    const { offer, timezone } = await this.db.withOrg(shop.orgId, async (tx) => ({
      offer: await this.delivery.offerTx(tx, preview.cart.store_id),
      timezone: await this.timezoneTx(tx, preview.cart.store_id),
    }));
    const refusal = offer.offered
      ? deliveryRefusal(offer.terms, input.delivery.address.postal_code, BigInt(preview.view.subtotal_minor))
      : "Delivery isn't available right now. Pickup is.";
    if (refusal) throw new ApiException('validation_failed', refusal, { retryable: false });

    let ageCheck: string | null = null;
    if (preview.view.minimum_age !== null) {
      const result = await this.ages.check({
        firstName: preview.contact.firstName,
        lastName: preview.contact.lastName,
        dateOfBirth: input.delivery.date_of_birth,
        address: {
          line1: input.delivery.address.address_line1,
          city: input.delivery.address.city,
          region: input.delivery.address.region,
          postalCode: input.delivery.address.postal_code,
        },
        minimumAge: preview.view.minimum_age,
        timezone,
      });
      // What is kept: that a check was done, by which provider, its reference
      // and its answer. Not the date of birth, not the name.
      await this.db.withOrg(shop.orgId, (tx) =>
        tx.query(
          `INSERT INTO age_verifications (org_id, store_id, method, result, minimum_age_applied, provider, provider_token)
           VALUES (current_setting('app.org_id')::uuid, $1, 'provider', $2, $3, $4, $5)`,
          [preview.cart.store_id, result.passed ? 'pass' : 'fail', preview.view.minimum_age, result.provider, result.reference],
        ),
      );
      if (!result.passed) {
        throw new ApiException('validation_failed', result.message ?? "We couldn't verify your age.", {
          retryable: false,
        });
      }
      ageCheck = result.reference;
    }

    const amountMinor = BigInt(preview.view.estimated_total_minor);
    const hold = await this.payments.processor().authorize({
      amountMinor,
      token: input.payment_token ?? '',
      description: 'Online delivery order',
    });
    if (!hold.approved) {
      throw new ApiException('validation_failed', hold.declineReason ?? 'The payment was declined.', { retryable: false });
    }

    return {
      phone,
      address: input.delivery.address,
      feeMinor: BigInt(preview.view.delivery_fee_minor),
      amountMinor,
      hold,
      ageCheck,
    };
  }

  /** Who the order is for: a signed-in customer's own record, or the guest's details. */
  private async contactTx(tx: PoolClient, session: CustomerSession | null, input: ShopCheckout): Promise<Contact> {
    if (session) {
      const { rows } = await tx.query<{ email: string | null; first_name: string | null; last_name: string | null }>(
        `SELECT email, first_name, last_name FROM customers WHERE id = $1`,
        [session.customerId],
      );
      if (!rows[0]?.email) {
        throw new ApiException('validation_failed', 'Add an email address to your account first.', {
          retryable: false,
        });
      }
      const firstName = rows[0].first_name ?? '';
      const lastName = rows[0].last_name ?? '';
      return {
        order: { customer_id: session.customerId },
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`.trim() || rows[0].email,
      };
    }
    if (!input.contact) {
      throw new ApiException('validation_failed', 'Tell us who the order is for.', { retryable: false });
    }
    const phone = input.contact.phone ? normalizeUsPhone(input.contact.phone) : null;
    return {
      order: {
        guest_name: `${input.contact.first_name} ${input.contact.last_name}`,
        guest_email: input.contact.email.toLowerCase(),
        ...(phone ? { guest_phone: phone } : input.delivery ? { guest_phone: normalizeUsPhone(input.delivery.phone) ?? undefined } : {}),
      },
      firstName: input.contact.first_name,
      lastName: input.contact.last_name,
      fullName: `${input.contact.first_name} ${input.contact.last_name}`,
    };
  }

  private async timezoneTx(tx: PoolClient, storeId: string): Promise<string> {
    const { rows } = await tx.query<{ timezone: string }>(`SELECT timezone FROM stores WHERE id = $1`, [storeId]);
    return rows[0]?.timezone ?? 'America/Chicago';
  }

  private async release(hold: PaymentAuthorization): Promise<void> {
    try {
      await this.payments.processorNamed(hold.provider).release(hold.reference);
    } catch (e) {
      // Logged without the reference's owner or amount; the processor's own
      // records are where an unreleased hold is chased.
      this.logger.error({ provider: hold.provider, err: e instanceof Error ? e.message : e }, 'could not release a payment hold');
    }
  }
}

interface Contact {
  order: { customer_id?: string; guest_name?: string; guest_email?: string; guest_phone?: string | undefined };
  firstName: string;
  lastName: string;
  fullName: string;
}

interface DeliveryDetails {
  phone: string;
  address: NonNullable<ShopCheckout['delivery']>['address'];
  feeMinor: bigint;
  amountMinor: bigint;
  hold: PaymentAuthorization;
  ageCheck: string | null;
}
