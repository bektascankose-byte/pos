import { Injectable, OnModuleInit } from '@nestjs/common';
import type { OrderStatus } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { TransactionalMailer } from '../../platform/messaging/transactional-mailer.js';
import { OutboxPump, type OutboxContext } from '../../platform/outbox/outbox.pump.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  orderDeliveredMessage,
  orderDeliveryFailedMessage,
  orderOnItsWayMessage,
  orderPlacedMessage,
  orderReadyMessage,
  orderStoppedMessage,
  type EmailContent,
  type OrderEmailFacts,
} from './shop-emails.js';
import { TrackingTokens } from './tracking-tokens.js';

/**
 * The emails a website order sends as it moves: received; ready for pickup, or
 * on its way and delivered; or stopped.
 *
 * Driven by the outbox rather than called from the order code, so an email is
 * sent only for a change that actually committed, and a provider that is down
 * delays the email instead of failing the order. The pump retries with
 * backoff; a handler may therefore run twice for one event, and the worst that
 * does is send a duplicate, which is the right side to err on for "your order
 * is ready".
 *
 * Only orders placed on the website email anyone. An order keyed in by staff
 * was placed by someone standing in front of the customer.
 */
@Injectable()
export class ShopNotifications implements OnModuleInit {
  constructor(
    private readonly pump: OutboxPump,
    private readonly db: DatabaseService,
    private readonly orders: OrdersService,
    private readonly mailer: TransactionalMailer,
    private readonly tokens: TrackingTokens,
  ) {}

  onModuleInit(): void {
    this.pump.register('order.placed', (payload, ctx) => this.onPlaced(payload, ctx));
    this.pump.register('order.status_changed', (payload, ctx) => this.onStatusChanged(payload, ctx));
  }

  private async onPlaced(payload: Record<string, unknown>, ctx: OutboxContext): Promise<void> {
    if (payload.placed_via !== 'storefront' || typeof payload.order_id !== 'string') return;
    await this.notify(ctx.orgId, payload.order_id, orderPlacedMessage);
  }

  private async onStatusChanged(payload: Record<string, unknown>, ctx: OutboxContext): Promise<void> {
    if (typeof payload.order_id !== 'string') return;
    // A customer who cancelled their own order already saw it happen.
    if (payload.by === 'customer') return;

    const to = payload.to as OrderStatus;
    const orderId = payload.order_id;
    if (to === 'ready') {
      // A packed delivery order is about to go out; its next email is "on its way".
      await this.notify(ctx.orgId, orderId, (facts) => (facts.fulfilment === 'pickup' ? orderReadyMessage(facts) : null));
    } else if (to === 'in_transit') {
      await this.notify(ctx.orgId, orderId, orderOnItsWayMessage);
    } else if (to === 'completed') {
      // A pickup customer was standing at the counter; a delivery customer gets a receipt of sorts.
      await this.notify(ctx.orgId, orderId, (facts) => (facts.fulfilment === 'delivery' ? orderDeliveredMessage(facts) : null));
    } else if (to === 'delivery_failed') {
      await this.notify(ctx.orgId, orderId, orderDeliveryFailedMessage);
    } else if (to === 'rejected' || to === 'cancelled') {
      await this.notify(ctx.orgId, orderId, (facts) => orderStoppedMessage(facts, to));
    }
  }

  private async notify(
    orgId: string,
    orderId: string,
    compose: (facts: OrderEmailFacts) => EmailContent | null,
  ): Promise<void> {
    const found = await this.db.withOrg(orgId, async (tx) => {
      const order = await this.orders.loadTx(tx, orderId);
      if (order.placed_via !== 'storefront') return null;

      const { rows } = await tx.query<{
        shop: string;
        email: string | null;
        first_name: string | null;
        store_name: string;
        address_line1: string | null;
        city: string | null;
        region: string | null;
        postal_code: string | null;
        phone: string | null;
      }>(
        `SELECT org.display_name AS shop,
                COALESCE(c.email, o.guest_email) AS email,
                COALESCE(c.first_name, split_part(o.guest_name, ' ', 1)) AS first_name,
                s.name AS store_name, s.address_line1, s.city, s.region, s.postal_code, s.phone
         FROM orders o
         JOIN stores s ON s.id = o.store_id
         JOIN organizations org ON org.id = o.org_id
         LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.id = $1`,
        [orderId],
      );
      const row = rows[0];
      if (!row?.email) return null;

      const { rows: points } = await tx.query<{ points: number }>(
        `SELECT points FROM loyalty_ledger WHERE sale_id = $1 AND kind = 'earn'`,
        [order.sale_id],
      );

      const address = [row.address_line1, [row.city, row.region].filter(Boolean).join(', '), row.postal_code]
        .filter(Boolean)
        .join(' ');
      return {
        to: row.email,
        facts: {
          shop: row.shop,
          firstName: row.first_name || null,
          orderNumber: order.order_number,
          trackingToken: this.tokens.sign(orgId, orderId),
          totalMinor: order.total_minor,
          storeName: row.store_name,
          storeAddress: address || null,
          storePhone: row.phone,
          minimumAge: order.minimum_age,
          resolutionNote: order.resolution_note,
          fulfilment: order.fulfilment,
          paymentSimulated: order.payment?.test ?? false,
          courierTrackingUrl: order.delivery?.tracking_url ?? null,
          deliverySimulated: order.delivery?.provider === 'simulated',
          pointsEarned: points[0]?.points ?? null,
        } satisfies OrderEmailFacts,
      };
    });
    if (!found) return;

    const message = compose(found.facts);
    if (!message) return;
    await this.mailer.send('order', { to: found.to, subject: message.subject, body: message.body });
  }
}
