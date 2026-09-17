import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { courierSteps, type CourierEvent, type Order, type OrderStatus } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { CourierService } from '../../platform/couriers/courier.service.js';
import { CourierRefusal, type CourierDeliveryRequest } from '../../platform/couriers/courier.js';
import { OrdersService } from '../orders/orders.service.js';
import { DeliverySettingsService } from './delivery-settings.service.js';

/** What a courier's report can tell us besides where the order has got to. */
export interface CourierReportDetails {
  providerStatus?: string | undefined;
  driverName?: string | undefined;
  trackingUrl?: string | undefined;
  supportReference?: string | undefined;
  feeMinor?: bigint | undefined;
  estimatedPickupAt?: string | undefined;
  estimatedDropoffAt?: string | undefined;
  cancellationReason?: string | undefined;
  occurredAt?: string | undefined;
}

/**
 * Getting a delivery order from the shelf to the door.
 *
 * Staff press one button when the bag is packed; the courier's reports -- real
 * webhooks, or simulated ones on a server without DoorDash -- do the rest,
 * through `applyCourierEvent`. Both kinds of report take the same path, so a
 * delivery simulated in the back office exercises exactly the code a real one
 * will.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly couriers: CourierService,
    private readonly orders: OrdersService,
    private readonly settings: DeliverySettingsService,
  ) {}

  /**
   * Book a driver for a packed delivery order.
   *
   * The booking happens between two transactions rather than inside one: a
   * courier's API can take seconds, and holding the order row locked while it
   * answers would stall the queue. The external id is fixed for each attempt,
   * so if the booking succeeds but the second transaction fails, pressing the
   * button again gets the same booking back instead of a second driver.
   */
  async dispatch(orgId: string, actorUserId: string, orderId: string): Promise<Order> {
    const courier = this.couriers.courier();
    const request = await this.db.withOrg(orgId, (tx) => this.requestTx(tx, orderId, courier.name));

    let booked;
    try {
      booked = await courier.createDelivery(request);
    } catch (e) {
      if (e instanceof CourierRefusal) {
        throw new ApiException('conflict', `${courier.displayName} would not take this delivery: ${e.detail}`, {
          retryable: false,
          userMessage: e.userMessage,
        });
      }
      throw e;
    }

    return this.db.withOrg(orgId, async (tx) => {
      const order = await this.orders.loadTx(tx, orderId);
      if (order.status !== 'ready') {
        // Somebody else sent it, or it was cancelled, while the courier answered.
        return order;
      }
      await tx.query(
        `UPDATE order_deliveries
            SET provider = $2, external_delivery_id = $3, provider_status = $4, tracking_url = $5,
                support_reference = $6, courier_fee_minor = $7::bigint, requested_at = now(),
                estimated_pickup_at = $8::timestamptz, estimated_dropoff_at = $9::timestamptz,
                driver_first_name = NULL, picked_up_at = NULL, dropped_off_at = NULL, cancellation_reason = NULL
          WHERE order_id = $1`,
        [
          orderId,
          courier.name,
          request.externalDeliveryId,
          booked.status,
          booked.trackingUrl,
          booked.supportReference,
          booked.feeMinor?.toString() ?? null,
          booked.estimatedPickupAt,
          booked.estimatedDropoffAt,
        ],
      );
      return this.orders.transitionTx(tx, actorUserId, orderId, 'courier_requested', {
        reason: courier.simulated ? 'Driver requested (simulated)' : `Driver requested from ${courier.displayName}`,
      });
    });
  }

  /**
   * Call off the driver before the order has left, and put the order back on
   * the shelf as a failed delivery -- to be sent again or cancelled.
   */
  async cancelCourier(orgId: string, actorUserId: string, orderId: string, reason: string): Promise<Order> {
    const externalId = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ status: OrderStatus; external_delivery_id: string | null }>(
        `SELECT o.status, d.external_delivery_id FROM orders o
         JOIN order_deliveries d ON d.order_id = o.id WHERE o.id = $1`,
        [orderId],
      );
      const row = rows[0];
      if (!row) throw ApiException.notFound('delivery order');
      if (row.status !== 'courier_requested' || !row.external_delivery_id) {
        throw new ApiException('conflict', 'only a delivery still waiting for its driver can have the driver cancelled', {
          retryable: false,
        });
      }
      return row.external_delivery_id;
    });

    await this.couriers.courier().cancelDelivery(externalId);

    const order = await this.applyCourierEvent(orgId, orderId, 'cancelled', {
      providerStatus: 'cancelled',
      cancellationReason: `Cancelled by the shop: ${reason}`,
    });
    await this.db.withOrg(orgId, (tx) =>
      this.audit.record(tx, {
        action: 'delivery.courier_cancelled',
        entityType: 'order',
        entityId: orderId,
        actorUserId,
        reason,
      }),
    );
    return order;
  }

  /** A courier report typed in from the back office, on a server simulating deliveries. */
  async simulate(orgId: string, actorUserId: string, orderId: string, event: CourierEvent): Promise<Order> {
    const provider = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ provider: string }>(`SELECT provider FROM order_deliveries WHERE order_id = $1`, [
        orderId,
      ]);
      return rows[0]?.provider;
    });
    if (!provider) throw ApiException.notFound('delivery order');
    if (provider !== 'simulated') {
      throw new ApiException('forbidden', 'only a simulated delivery can have courier reports typed in', {
        retryable: false,
      });
    }

    const details: CourierReportDetails =
      event === 'picked_up'
        ? { providerStatus: 'picked_up', driverName: 'Sam (simulated)' }
        : event === 'delivered'
          ? { providerStatus: 'delivered' }
          : event === 'returning'
            ? { providerStatus: 'returning', cancellationReason: 'Nobody 21 or older with a valid ID was at the door (simulated).' }
            : event === 'returned'
              ? { providerStatus: 'returned' }
              : { providerStatus: 'cancelled', cancellationReason: 'No driver accepted the delivery (simulated).' };

    const order = await this.applyCourierEvent(orgId, orderId, event, details);
    await this.db.withOrg(orgId, (tx) =>
      this.audit.record(tx, {
        action: 'delivery.simulated_report',
        entityType: 'order',
        entityId: orderId,
        actorUserId,
        newValue: { event },
      }),
    );
    return order;
  }

  /**
   * Record what a courier reported, and walk the order through whatever status
   * changes the report implies.
   *
   * Idempotent: a report the order has already moved past takes no steps, so a
   * webhook delivered three times moves the order once. Out of order: a
   * "delivered" for an order whose "picked up" never arrived walks through
   * `in_transit` on the way, rather than being refused.
   */
  async applyCourierEvent(
    orgId: string,
    orderId: string,
    event: CourierEvent,
    details: CourierReportDetails,
  ): Promise<Order> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ status: OrderStatus; provider: string; external_delivery_id: string | null }>(
        `SELECT o.status, d.provider, d.external_delivery_id
         FROM orders o JOIN order_deliveries d ON d.order_id = o.id
         WHERE o.id = $1 FOR UPDATE OF o`,
        [orderId],
      );
      const current = rows[0];
      if (!current) throw ApiException.notFound('delivery order');

      await this.recordReportTx(tx, orderId, event, details);

      let order: Order | null = null;
      for (const step of courierSteps(event, current.status)) {
        order = await this.orders.transitionTx(tx, null, orderId, step, {
          actorType: 'courier',
          courier: { name: current.provider, reference: current.external_delivery_id },
          reason: step === 'delivery_failed' ? (details.cancellationReason ?? reasonFor(event)) : undefined,
        });
      }
      return order ?? this.orders.loadTx(tx, orderId);
    });
  }

  private async recordReportTx(tx: PoolClient, orderId: string, event: CourierEvent, details: CourierReportDetails) {
    // First name only: the driver's full name is theirs, and "Sam is on the
    // way" is all a customer needs.
    const driverFirstName = details.driverName?.trim().split(/\s+/)[0] ?? null;
    await tx.query(
      `UPDATE order_deliveries
          SET provider_status      = COALESCE($2, provider_status),
              driver_first_name    = COALESCE($3, driver_first_name),
              tracking_url         = COALESCE($4, tracking_url),
              support_reference    = COALESCE($5, support_reference),
              courier_fee_minor    = COALESCE($6::bigint, courier_fee_minor),
              estimated_pickup_at  = COALESCE($7::timestamptz, estimated_pickup_at),
              estimated_dropoff_at = COALESCE($8::timestamptz, estimated_dropoff_at),
              picked_up_at   = CASE WHEN $9::text IN ('picked_up', 'delivered') THEN COALESCE(picked_up_at, $11::timestamptz, now()) ELSE picked_up_at END,
              dropped_off_at = CASE WHEN $9::text = 'delivered' THEN COALESCE(dropped_off_at, $11::timestamptz, now()) ELSE dropped_off_at END,
              cancellation_reason = COALESCE($10, cancellation_reason)
        WHERE order_id = $1`,
      [
        orderId,
        details.providerStatus ?? null,
        driverFirstName,
        details.trackingUrl ?? null,
        details.supportReference ?? null,
        details.feeMinor?.toString() ?? null,
        details.estimatedPickupAt ?? null,
        details.estimatedDropoffAt ?? null,
        event,
        details.cancellationReason ?? null,
        details.occurredAt ?? null,
      ],
    );
  }

  /** Everything a courier needs to take this order, built from the order and the shop. */
  private async requestTx(tx: PoolClient, orderId: string, courierName: string): Promise<CourierDeliveryRequest> {
    const order = await this.orders.loadTx(tx, orderId);
    if (order.fulfilment !== 'delivery' || !order.delivery) {
      throw new ApiException('conflict', 'this is not a delivery order', { retryable: false });
    }
    if (order.status !== 'ready') {
      throw new ApiException('conflict', 'mark the order ready once it is packed, then request a driver', {
        retryable: false,
      });
    }

    const { rows: stores } = await tx.query<{
      shop_name: string;
      address_line1: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      phone: string | null;
    }>(
      `SELECT o.display_name AS shop_name, s.address_line1, s.city, s.region, s.postal_code, s.phone
       FROM stores s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`,
      [order.store_id],
    );
    const store = stores[0]!;
    if (courierName !== 'simulated' && (!store.address_line1 || !store.postal_code || !store.phone)) {
      throw new ApiException(
        'conflict',
        "add the store's street address, ZIP code and phone number before requesting a driver",
        { retryable: false },
      );
    }

    // Each attempt gets its own id: a courier will not reuse the id of a
    // delivery it already cancelled or returned.
    const { rows: attempts } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM order_events WHERE order_id = $1 AND to_status = 'courier_requested'`,
      [orderId],
    );
    const attempt = Number(attempts[0]!.n) + 1;

    const { rows: flags } = await tx.query<{ tobacco: boolean; hemp: boolean }>(
      `SELECT COALESCE(bool_or(pc.contains_nicotine OR pc.regulated_class IN ('ends', 'tobacco', 'cigar', 'cigarette', 'smokeless', 'pouch')
                               OR COALESCE(pc.minimum_age, 0) >= 21), false) AS tobacco,
              COALESCE(bool_or(pc.contains_cannabinoid OR pc.regulated_class = 'consumable_hemp'), false) AS hemp
       FROM order_lines l
       JOIN product_variants v ON v.id = l.variant_id
       LEFT JOIN product_compliance pc ON pc.product_id = v.product_id
       WHERE l.order_id = $1 AND l.removed_at IS NULL`,
      [orderId],
    );
    const offer = await this.settings.offerTx(tx, order.store_id);
    const [givenName, ...rest] = order.delivery.recipient_name.trim().split(/\s+/);
    const oneLine = (parts: (string | null)[]) => parts.filter(Boolean).join(', ');

    return {
      externalDeliveryId: `snappos-${orderId}-${attempt}`,
      pickup: {
        businessName: store.shop_name,
        address: oneLine([store.address_line1, store.city, `${store.region ?? ''} ${store.postal_code ?? ''}`.trim()]),
        phone: store.phone,
        instructions: offer.pickupInstructions,
        referenceTag: `Order ${order.order_number}`,
      },
      dropoff: {
        address: oneLine([
          order.delivery.address_line1,
          order.delivery.address_line2,
          order.delivery.city,
          `${order.delivery.region} ${order.delivery.postal_code}`,
        ]),
        phone: order.delivery.recipient_phone,
        givenName: givenName ?? order.delivery.recipient_name,
        familyName: rest.join(' ') || '-',
        instructions: order.delivery.dropoff_instructions,
      },
      orderValueMinor: BigInt(order.total_minor),
      // Any line needing an age check, even one the compliance data does not
      // classify, makes the courier check ID: refusing a check nobody needed
      // costs a minute; skipping one that was needed is the thing to prevent.
      containsTobacco: flags[0]!.tobacco || order.minimum_age !== null,
      containsHemp: flags[0]!.hemp,
    };
  }
}

function reasonFor(event: CourierEvent): string {
  switch (event) {
    case 'cancelled':
      return 'The courier cancelled the delivery.';
    case 'returning':
    case 'returned':
      return 'The driver could not hand the order over and is bringing it back.';
    default:
      return 'The delivery could not be completed.';
  }
}
