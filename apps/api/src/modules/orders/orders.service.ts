import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  assertTransition,
  InvalidOrderTransition,
  isTerminal,
  money,
  movesStock,
  saleInput,
  taxForCharge,
  taxForLine,
  type Order,
  type OrderDelivery,
  type OrderEvent,
  type OrderFulfilment,
  type OrderLine,
  type OrderPayment,
  type OrderQueueEntry,
  type OrderStatus,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { OutboxService } from '../../platform/outbox/outbox.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { PaymentsService } from '../../platform/payments/payments.service.js';
import { AvailabilityService, type RequestedLine } from '../storefront/availability.service.js';
import { ComplianceService, type JurisdictionContext } from '../compliance/compliance.service.js';
import { SalesService } from '../sales/sales.service.js';
import { taxRatesByCategory } from './order-tax.js';

/** How a pickup order was paid at the counter. Delivery orders are paid online, before they leave. */
export type TenderMethod = 'cash' | 'card' | 'other';

export interface PlaceOrderLine {
  variant_id: string;
  quantity: string;
}

/** Where a delivery order is going. */
export interface OrderDeliveryInput {
  /** 'doordash' or 'simulated'. */
  provider: string;
  recipient_name: string;
  recipient_phone: string;
  address_line1: string;
  address_line2?: string | undefined;
  city: string;
  region: string;
  postal_code: string;
  dropoff_instructions?: string | undefined;
}

export interface PlaceOrderInput {
  store_id: string;
  fulfilment: OrderFulfilment;
  customer_id?: string | undefined;
  guest_name?: string | undefined;
  guest_email?: string | undefined;
  guest_phone?: string | undefined;
  lines: PlaceOrderLine[];
  pickup_from?: string | undefined;
  pickup_to?: string | undefined;
  note?: string | undefined;
  correlation_id?: string | undefined;
  /** 'storefront' when a customer placed it. Only those orders email the customer. */
  placed_via?: 'staff' | 'storefront' | undefined;
  /** When the customer stated they are old enough. A statement, not a check. */
  age_attested_at?: string | undefined;
  /** Required for delivery, refused for pickup. */
  delivery?: OrderDeliveryInput | undefined;
  /** What the customer pays for delivery, worked out by the caller from the shop's delivery terms. */
  delivery_fee_minor?: string | undefined;
}

/**
 * Placing an order either produces one or is refused by the compliance engine.
 *
 * A refusal is returned rather than thrown so that the transaction it happened
 * in can commit the record of it; see `placeTx`.
 */
export type PlaceOutcome = { refusal: string } | { order: Order };

export interface TransitionOptions {
  reason?: string | undefined;
  correlationId?: string | undefined;
  /** Required when completing a pickup: a finished sale must record how it was paid. */
  tender?: TenderMethod | undefined;
  /** Whoever hands over has looked at the customer's photo ID. Required when any line needs it. */
  idChecked?: boolean | undefined;
  /**
   * Who moved it: staff at the counter, the customer on the website, or the
   * courier's own report of where a delivery has got to.
   */
  actorType?: 'staff' | 'customer' | 'courier' | undefined;
  /** For a courier's report: which courier, and its reference for the delivery. */
  courier?: { name: string; reference: string | null } | undefined;
}

type OnlineTender = {
  kind: 'online';
  provider: string;
  reference: string;
  cardBrand: string | null;
  cardLast4: string | null;
};

/** The system catalog item a delivery fee rings up as. */
const DELIVERY_FEE_SKU = 'DELIVERY-FEE';

/**
 * Online orders, and the queue staff work them from.
 *
 * The one rule that shapes everything here: **an order claims stock, it does
 * not move it.** Nothing touches the inventory ledger until handoff, and at
 * handoff the movement and the sale that explains it are written in the same
 * transaction. An order cancelled at any point before that simply stops
 * existing as a claim; no compensating movement is needed because none was
 * ever made.
 *
 * Handoff means two different things. A pickup order is handed over at the
 * counter, by staff, who say how it was paid. A delivery order was paid for
 * online and is handed over at the customer's door by a courier, so it is the
 * courier's report of that -- a webhook, or a simulated one -- that completes
 * it, takes the payment and writes the sale.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly availability: AvailabilityService,
    private readonly compliance: ComplianceService,
    private readonly sales: SalesService,
    private readonly payments: PaymentsService,
  ) {}

  /** Place an order in a transaction of its own. */
  async place(orgId: string, input: PlaceOrderInput): Promise<Order> {
    const outcome = await this.db.withOrg(orgId, (tx) => this.placeTx(tx, input));
    if ('refusal' in outcome) {
      throw new ApiException('validation_failed', outcome.refusal, { retryable: false });
    }
    return outcome.order;
  }

  /**
   * Place an order, inside a transaction the caller owns.
   *
   * Availability, compliance, the order, its lines, its first event and the
   * outbox message all land together or not at all. That is the whole design:
   * an order that exists without its event never reaches the counter, and an
   * event for an order that rolled back sends someone looking for a sale nobody
   * made. The storefront's checkout calls this inside the same transaction that
   * marks its cart converted, which is what makes a double-clicked Place Order
   * produce one order.
   *
   * Both gates are re-run here even though the storefront checked them while
   * the customer was shopping. Stock moves at the counter and rules change;
   * the only check worth trusting is the one inside the transaction that
   * writes the order.
   */
  async placeTx(tx: PoolClient, input: PlaceOrderInput): Promise<PlaceOutcome> {
    if (input.lines.length === 0) {
      throw new ApiException('validation_failed', 'an order needs at least one item', {
        retryable: false,
      });
    }
    if ((input.fulfilment === 'delivery') !== Boolean(input.delivery)) {
      throw new ApiException(
        'validation_failed',
        input.fulfilment === 'delivery' ? 'a delivery order needs an address' : 'a pickup order has no delivery address',
        { retryable: false },
      );
    }

    const channel = input.fulfilment === 'pickup' ? 'pickup' : 'delivery';
    const jurisdiction = await this.jurisdictionFor(tx, input.store_id);
    const asOf = new Date();
    const variantIds = input.lines.map((line) => line.variant_id);

    // Compliance first: an item that may not be sold at all should say so,
    // rather than being reported as merely out of stock.
    const decisions = await this.compliance.checkCartTx(tx, channel, jurisdiction, variantIds, asOf);
    const refused = decisions.filter((decision) => !decision.allowed);
    if (refused.length > 0) {
      // Recorded even though the order is refused -- especially then. "Why
      // could this customer not buy this" is the question that gets asked.
      // Returned rather than thrown, so the transaction commits the record:
      // throwing here would roll the evidence back along with the order.
      await this.compliance.record(tx, { channel, jurisdiction, asOf, decisions });
      return { refusal: refused.map((decision) => decision.reason).join(' ') };
    }

    const problems = await this.availability.checkTx(
      tx,
      input.store_id,
      input.fulfilment,
      input.lines.map((line): RequestedLine => ({ variantId: line.variant_id, quantity: line.quantity })),
    );
    if (problems.length > 0) {
      throw new ApiException('conflict', describeProblems(problems), { retryable: false });
    }

    const priced = await this.priceLines(tx, input.store_id, input.lines);
    const orderNumber = await this.nextOrderNumber(tx, input.store_id);
    const placedVia = input.placed_via ?? 'staff';

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO orders
         (org_id, store_id, order_number, customer_id, guest_name, guest_email, guest_phone,
          fulfilment, status, pickup_from, pickup_to, note, correlation_id,
          placed_via, age_attested_at, delivery_fee_minor)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, 'placed',
               $8::timestamptz, $9::timestamptz, $10, $11, $12, $13::timestamptz, $14::bigint)
       RETURNING id`,
      [
        input.store_id,
        orderNumber,
        input.customer_id ?? null,
        input.guest_name ?? null,
        input.guest_email ?? null,
        input.guest_phone ?? null,
        input.fulfilment,
        input.pickup_from ?? null,
        input.pickup_to ?? null,
        input.note ?? null,
        input.correlation_id ?? null,
        placedVia,
        input.age_attested_at ?? null,
        input.fulfilment === 'delivery' ? (input.delivery_fee_minor ?? '0') : '0',
      ],
    );
    const orderId = rows[0]!.id;

    for (const line of priced) {
      await tx.query(
        `INSERT INTO order_lines
           (org_id, order_id, variant_id, quantity, unit_price_minor, line_total_minor,
            description, upc_snapshot)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
        [
          orderId,
          line.variant_id,
          line.quantity,
          line.unit_price_minor,
          line.line_total_minor,
          line.description,
          line.upc_snapshot,
        ],
      );
    }

    if (input.delivery) {
      const d = input.delivery;
      await tx.query(
        `INSERT INTO order_deliveries
           (order_id, org_id, provider, recipient_name, recipient_phone, address_line1, address_line2,
            city, region, postal_code, dropoff_instructions)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orderId,
          d.provider,
          d.recipient_name,
          d.recipient_phone,
          d.address_line1,
          d.address_line2 ?? null,
          d.city,
          d.region,
          d.postal_code,
          d.dropoff_instructions ?? null,
        ],
      );
    }

    const totals = await this.recomputeTotals(tx, orderId, input.store_id, input.fulfilment);

    await this.compliance.record(tx, { orderId, channel, jurisdiction, asOf, decisions });

    await this.event(tx, orderId, null, 'placed', {
      actorType: placedVia === 'storefront' ? 'customer' : 'staff',
      correlationId: input.correlation_id,
    });

    // What makes the order appear at the counter, and what sends the customer
    // their confirmation. Written here, delivered by the pump, so a network
    // that is down cannot lose either.
    await this.outbox.emit(tx, {
      eventType: 'order.placed',
      aggregateType: 'order',
      aggregateId: orderId,
      storeId: input.store_id,
      correlationId: input.correlation_id,
      payload: {
        order_id: orderId,
        order_number: orderNumber,
        fulfilment: input.fulfilment,
        placed_via: placedVia,
        line_count: priced.length,
        total_minor: totals.total.toString(),
      },
    });

    return { order: await this.loadTx(tx, orderId) };
  }

  /** The POS queue: what needs attention, oldest first. */
  async queue(orgId: string, storeId: string): Promise<OrderQueueEntry[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<OrderQueueEntry>(
        `SELECT o.id, o.order_number, o.fulfilment, o.status, o.total_minor::text,
                o.placed_at, o.accepted_at, o.ready_at, o.pickup_from, o.pickup_to, o.note,
                COALESCE(c.first_name || ' ' || c.last_name, o.guest_name) AS customer_name,
                (SELECT count(*)::int FROM order_lines l
                  WHERE l.order_id = o.id AND l.removed_at IS NULL) AS line_count,
                -- How long it has been waiting, which is the number a shop
                -- actually manages the queue by.
                round(extract(epoch FROM now() - o.placed_at))::int AS waiting_seconds,
                (SELECT NULLIF(max(GREATEST(COALESCE(d.minimum_age, 0), COALESCE(pc.minimum_age, 0))), 0)::int
                   FROM order_lines l
                   JOIN product_variants v ON v.id = l.variant_id
                   LEFT JOIN product_compliance pc ON pc.product_id = v.product_id
                   LEFT JOIN compliance_decisions d ON d.order_id = l.order_id AND d.variant_id = l.variant_id
                  WHERE l.order_id = o.id AND l.removed_at IS NULL) AS minimum_age,
                od.postal_code AS delivery_postal_code,
                od.provider_status AS courier_status,
                EXISTS (SELECT 1 FROM order_payments p
                         WHERE p.order_id = o.id AND p.status IN ('authorized', 'captured')) AS paid_online
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN order_deliveries od ON od.order_id = o.id
         WHERE o.store_id = $1
           AND o.status IN ('placed', 'accepted', 'preparing', 'ready',
                            'courier_requested', 'in_transit', 'delivery_failed', 'returned_to_store')
         ORDER BY o.placed_at`,
        [storeId],
      );
      return rows;
    });
  }

  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, (tx) => this.loadTx(tx, id));
  }

  /** Move an order along, in a transaction of its own. */
  async transition(
    orgId: string,
    actorUserId: string | null,
    id: string,
    to: OrderStatus,
    options: TransitionOptions = {},
  ): Promise<Order> {
    return this.db.withOrg(orgId, (tx) => this.transitionTx(tx, actorUserId, id, to, options));
  }

  /**
   * Move an order along, inside a transaction the caller owns.
   *
   * Every status change in the system funnels through here so the transition
   * check cannot be skipped by a caller in a hurry, and so every change writes
   * its event and its outbox message without anybody remembering to.
   */
  async transitionTx(
    tx: PoolClient,
    actorUserId: string | null,
    id: string,
    to: OrderStatus,
    options: TransitionOptions = {},
  ): Promise<Order> {
    const current = await this.lockOrder(tx, id);

    try {
      assertTransition(current.status, to);
    } catch (e) {
      if (e instanceof InvalidOrderTransition) {
        throw new ApiException('conflict', e.message, { retryable: false });
      }
      throw e;
    }

    if (to === 'rejected' || to === 'cancelled') {
      if (!options.reason?.trim()) {
        throw new ApiException(
          'validation_failed',
          'say why — the customer is told this, and "cancelled" on its own is not an answer',
          { retryable: false },
        );
      }
    }

    // A driver is booked or already has the bag. Calling the order off here
    // would leave the courier's booking behind; the driver is cancelled first.
    if (to === 'cancelled' && ['courier_requested', 'in_transit'].includes(current.status) && options.actorType !== 'courier') {
      throw new ApiException('conflict', 'cancel the driver first — the order is with the courier', {
        retryable: false,
        userMessage: 'A driver is booked for this order. Cancel the driver first.',
      });
    }

    // Handing over is the only transition that moves anything. Everything
    // else is bookkeeping.
    let saleId: string | null = null;
    if (movesStock(to)) {
      saleId =
        current.fulfilment === 'delivery'
          ? await this.completeDeliveryTx(tx, current, options)
          : await this.completePickupTx(tx, actorUserId, current, options);
    }

    // Money held for an order that will now never be handed over goes back.
    if (to === 'rejected' || to === 'cancelled') {
      await this.releasePaymentTx(tx, id);
    }

    await tx.query(
      // Every $2 is cast. Without the casts Postgres deduces the parameter's
      // type once per use site -- order_status from the assignment, text from
      // the bare comparisons -- and refuses the statement outright.
      `UPDATE orders
          SET status = $2::order_status,
              accepted_at  = CASE WHEN $2::order_status = 'accepted'  THEN now() ELSE accepted_at  END,
              ready_at     = CASE WHEN $2::order_status = 'ready'     THEN now() ELSE ready_at     END,
              completed_at = CASE WHEN $2::order_status = 'completed' THEN now() ELSE completed_at END,
              cancelled_at = CASE WHEN $2::order_status IN ('cancelled','rejected') THEN now() ELSE cancelled_at END,
              resolution_note = COALESCE($3, resolution_note),
              sale_id = COALESCE($4::uuid, sale_id)
        WHERE id = $1`,
      [id, to, options.reason ?? null, saleId],
    );

    const actorType = options.actorType ?? 'staff';

    await this.event(tx, id, current.status, to, {
      actorUserId: actorUserId ?? undefined,
      actorType,
      reason: options.reason,
      correlationId: options.correlationId,
    });

    await this.audit.record(tx, {
      action: `order.${to}`,
      entityType: 'order',
      entityId: id,
      actorUserId: actorUserId ?? undefined,
      actorType: actorType === 'customer' ? 'customer' : actorType === 'courier' ? 'system' : 'user',
      oldValue: { status: current.status },
      newValue: { status: to, sale_id: saleId, ...(options.courier ? { courier: options.courier.name } : {}) },
      reason: options.reason,
    });

    await this.outbox.emit(tx, {
      eventType: 'order.status_changed',
      aggregateType: 'order',
      aggregateId: id,
      storeId: current.store_id,
      correlationId: options.correlationId,
      payload: {
        order_id: id,
        from: current.status,
        to,
        sale_id: saleId,
        by: actorType,
      },
    });

    return this.loadTx(tx, id);
  }

  /**
   * Take a line off an order that cannot be filled.
   *
   * Marked rather than deleted: a customer who ordered four and collected three
   * should be able to see that happened, and so should whoever answers the
   * phone about it.
   */
  async removeLine(orgId: string, actorUserId: string, id: string, lineId: string, reason: string) {
    if (!reason.trim()) {
      throw new ApiException('validation_failed', 'say why the line could not be filled', {
        retryable: false,
      });
    }

    return this.db.withOrg(orgId, async (tx) => {
      const order = await this.lockOrder(tx, id);
      // Asked of the state machine rather than listed again here, so a status
      // added later cannot be terminal there and editable here.
      if (isTerminal(order.status)) {
        throw new ApiException('conflict', 'this order is finished and cannot be changed', {
          retryable: false,
        });
      }
      // Once a courier has it, the bag is sealed and gone.
      if (['courier_requested', 'in_transit'].includes(order.status)) {
        throw new ApiException('conflict', 'this order is already with the courier and cannot be changed', {
          retryable: false,
        });
      }

      const { rowCount } = await tx.query(
        `UPDATE order_lines SET removed_at = now(), removed_reason = $3
          WHERE id = $2 AND order_id = $1 AND removed_at IS NULL`,
        [id, lineId, reason],
      );
      if (!rowCount) throw ApiException.notFound('order line');

      // The total follows the lines, tax included. A customer is charged for
      // what they get.
      await this.recomputeTotals(tx, id, order.store_id, order.fulfilment);

      await this.audit.record(tx, {
        action: 'order.line_removed',
        entityType: 'order',
        entityId: id,
        actorUserId,
        reason,
        newValue: { line_id: lineId },
      });

      return this.loadTx(tx, id);
    });
  }

  /** The order as the API returns it, read inside the caller's transaction. */
  loadTx(tx: PoolClient, id: string): Promise<Order> {
    return this.load(tx, id);
  }

  // ------------------------------------------------------------------ private

  /** The counter handover: staff say how it was paid, and have looked at the ID. */
  private async completePickupTx(
    tx: PoolClient,
    actorUserId: string | null,
    current: LockedOrder,
    options: TransitionOptions,
  ): Promise<string> {
    if (!actorUserId) {
      throw new ApiException('forbidden', 'only staff can hand an order over', { retryable: false });
    }
    if (!options.tender) {
      throw new ApiException(
        'validation_failed',
        'say how the customer paid — a completed sale has to record its tender',
        { retryable: false },
      );
    }

    // The check that counts. The website took the customer's word for their
    // age; the counter looks at the ID, the same as for any sale of these.
    const requirement = await this.ageRequirement(tx, current.id);
    if (requirement.minimumAge !== null && options.idChecked !== true) {
      throw new ApiException(
        'validation_failed',
        `check the customer's photo ID before handing this over — it has items for ${requirement.minimumAge} and over`,
        { retryable: false },
      );
    }

    // The totals are worked out again at the moment of sale, so the order
    // and the sale it becomes can never disagree about what was charged.
    await this.recomputeTotals(tx, current.id, current.store_id, current.fulfilment);
    const written = await this.writeSale(tx, actorUserId, current, options.tender);

    if (requirement.minimumAge !== null) {
      // Stored the way the register stores it: that a check happened, by
      // whom, against what age, and that it passed. Nothing from the ID
      // itself -- no name, no date of birth, no document number.
      await tx.query(
        `INSERT INTO age_verifications
           (org_id, store_id, register_id, sale_id, order_id, method, result,
            minimum_age_applied, employee_user_id)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, 'manual', 'pass', $5, $6)`,
        [current.store_id, written.registerId, written.saleId, current.id, requirement.minimumAge, actorUserId],
      );
    }
    return written.saleId;
  }

  /**
   * The doorstep handover, on the courier's word.
   *
   * Only a courier's report completes a delivery: nobody at the shop saw it
   * handed over. The money held at checkout is taken now, for the order as it
   * stands, and the sale is written with that payment as its tender. The ID
   * check at the door was the courier's, and is recorded as such.
   */
  private async completeDeliveryTx(tx: PoolClient, current: LockedOrder, options: TransitionOptions): Promise<string> {
    if (options.actorType !== 'courier') {
      throw new ApiException(
        'validation_failed',
        "a delivery is completed by the courier's report that it was handed over",
        { retryable: false },
      );
    }

    const payment = await this.livePaymentTx(tx, current.id);
    if (!payment) {
      throw new ApiException('conflict', 'this delivery order has no online payment to take', { retryable: false });
    }

    // The staff member who sent it out, whose name the sale goes under.
    const { rows: dispatchers } = await tx.query<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM order_events
       WHERE order_id = $1 AND to_status = 'courier_requested' AND actor_user_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [current.id],
    );
    const dispatcher = dispatchers[0]?.actor_user_id;
    if (!dispatcher) {
      throw new ApiException('conflict', 'nobody is recorded as sending this delivery out', { retryable: false });
    }

    const totals = await this.recomputeTotals(tx, current.id, current.store_id, current.fulfilment);

    if (payment.status === 'authorized') {
      await this.payments.processorNamed(payment.provider).capture(payment.provider_reference, totals.total);
      await tx.query(
        `UPDATE order_payments SET status = 'captured', captured_at = now(), amount_minor = $2 WHERE id = $1`,
        [payment.id, totals.total.toString()],
      );
    }

    const written = await this.writeSale(tx, dispatcher, current, {
      kind: 'online',
      provider: payment.provider,
      reference: payment.provider_reference,
      cardBrand: payment.card_brand,
      cardLast4: payment.card_last4,
    });

    const requirement = await this.ageRequirement(tx, current.id);
    if (requirement.minimumAge !== null) {
      // The courier checked ID and took a signature at the door; its reference
      // for the delivery is all that is kept about that check.
      await tx.query(
        `INSERT INTO age_verifications
           (org_id, store_id, register_id, sale_id, order_id, method, result,
            minimum_age_applied, provider, provider_token)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, 'provider', 'pass', $5, $6, $7)`,
        [
          current.store_id,
          written.registerId,
          written.saleId,
          current.id,
          requirement.minimumAge,
          options.courier?.name ?? 'courier',
          options.courier?.reference ?? null,
        ],
      );
    }
    return written.saleId;
  }

  /** The payment holding or having taken money for an order, if any. */
  private async livePaymentTx(tx: PoolClient, orderId: string) {
    const { rows } = await tx.query<{
      id: string;
      provider: string;
      provider_reference: string;
      status: 'authorized' | 'captured';
      card_brand: string | null;
      card_last4: string | null;
    }>(
      `SELECT id, provider, provider_reference, status, card_brand, card_last4
       FROM order_payments WHERE order_id = $1 AND status IN ('authorized', 'captured')
       FOR UPDATE`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /** Let go of money held for an order that will not be handed over. */
  private async releasePaymentTx(tx: PoolClient, orderId: string): Promise<void> {
    const payment = await this.livePaymentTx(tx, orderId);
    if (!payment || payment.status !== 'authorized') return;
    await this.payments.processorNamed(payment.provider).release(payment.provider_reference);
    await tx.query(`UPDATE order_payments SET status = 'voided', voided_at = now() WHERE id = $1`, [payment.id]);
  }

  /**
   * Write the sale this order became.
   *
   * Reuses `SalesService.intake`, the path every counter sale takes, so an
   * online sale lands in the same tables with the same shape: tax per line,
   * the item's cost, a tender, and a stock movement in the same transaction.
   * A delivery fee is a line of its own, on an item that holds no stock, so the
   * sale's total is still the sum of its lines.
   *
   * What stops a double handover producing two sales is not in here. The order
   * row is locked for the whole transition and the state machine refuses
   * completed -> completed, so a second attempt never reaches this method.
   */
  private async writeSale(
    tx: PoolClient,
    cashierUserId: string,
    order: LockedOrder,
    tender: TenderMethod | OnlineTender,
  ): Promise<{ saleId: string; registerId: string }> {
    const { rows: lines } = await tx.query<{
      variant_id: string;
      quantity: string;
      unit_price_minor: string;
      line_total_minor: string;
      description: string;
      upc_snapshot: string;
      unit_cost: string | null;
      tax_category_id: string | null;
    }>(
      `SELECT l.variant_id, l.quantity::text, l.unit_price_minor::text, l.line_total_minor::text,
              l.description, l.upc_snapshot, v.cost::text AS unit_cost, p.tax_category_id
       FROM order_lines l
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE l.order_id = $1 AND l.removed_at IS NULL
       ORDER BY l.created_at`,
      [order.id],
    );

    if (lines.length === 0) {
      throw new ApiException(
        'conflict',
        'every line was removed from this order — cancel it rather than handing over nothing',
        { retryable: false },
      );
    }

    const register = await this.onlineRegister(tx, order.store_id);
    const rates = await taxRatesByCategory(tx, order.store_id, order.fulfilment);
    const fee = money(order.delivery_fee_minor);
    const feeVariant = fee > 0n ? await this.deliveryFeeVariant(tx) : null;

    // v7 ids from Postgres rather than randomUUID: the sale, every line and
    // every tender must satisfy the same uuidV7 rule the register's own writes
    // do, and a line id doubles as its inventory ledger id.
    const { rows: ids } = await tx.query<{ id: string }>(
      `SELECT uuid_generate_v7() AS id FROM generate_series(1, $1)`,
      [lines.length + 3],
    );
    const saleId = ids[0]!.id;
    const paymentId = ids[1]!.id;
    const feeLineId = ids[2]!.id;

    const now = new Date();
    const taxed = lines.map((line) => {
      const taxable = money(line.line_total_minor);
      const lineRates = rates.get(line.tax_category_id ?? '') ?? [];
      const { tax, snapshot } = taxForLine(taxable, lineRates);
      return { line, taxable, rates: lineRates, tax, snapshot, total: taxable + tax };
    });
    const feeTax = taxForCharge(
      fee,
      taxed.map((t) => ({ amount: t.taxable, rates: t.rates })),
    );

    const itemsSubtotal = taxed.reduce((sum, t) => sum + t.taxable, 0n);
    const subtotal = itemsSubtotal + fee;
    const taxTotal = taxed.reduce((sum, t) => sum + t.tax, 0n) + feeTax.tax;
    const total = subtotal + taxTotal;

    const saleLines = taxed.map(({ line, tax, snapshot, total: lineTotal }, index) => ({
      id: ids[index + 3]!.id,
      line_no: index + 1,
      variant_id: line.variant_id,
      description: line.description,
      sku_snapshot: line.upc_snapshot,
      quantity: line.quantity,
      unit_price_minor: line.unit_price_minor,
      original_price_minor: line.unit_price_minor,
      price_overridden: false,
      discount_minor: '0',
      tax_minor: tax.toString(),
      total_minor: lineTotal.toString(),
      // What the item cost, as the register records it. A zero here would
      // make every online sale look like pure profit and value the stock
      // that left at nothing.
      unit_cost: line.unit_cost ?? '0',
      tax_snapshot: snapshot,
    }));
    if (feeVariant) {
      saleLines.push({
        id: feeLineId,
        line_no: saleLines.length + 1,
        variant_id: feeVariant,
        description: 'Delivery fee',
        sku_snapshot: DELIVERY_FEE_SKU,
        quantity: '1',
        unit_price_minor: fee.toString(),
        original_price_minor: fee.toString(),
        price_overridden: false,
        discount_minor: '0',
        tax_minor: feeTax.tax.toString(),
        total_minor: (fee + feeTax.tax).toString(),
        unit_cost: '0',
        tax_snapshot: feeTax.snapshot,
      });
    }

    const payment =
      typeof tender === 'string'
        ? { id: paymentId, method: tender, status: 'captured', amount_minor: total.toString() }
        : {
            id: paymentId,
            method: 'card',
            status: 'captured',
            amount_minor: total.toString(),
            provider: tender.provider,
            provider_payment_id: tender.reference,
            ...(tender.cardBrand ? { card_brand: tender.cardBrand } : {}),
            ...(tender.cardLast4 ? { card_last4: tender.cardLast4 } : {}),
            entry_mode: 'online',
          };

    // Parsed, not cast. The register's own sales arrive through this schema and
    // pick up its defaults on the way. A cast would type-check and then write a
    // null into a NOT NULL column at the one moment that matters, which is
    // exactly what it once did.
    const sale = saleInput.parse({
      id: saleId,
      store_id: order.store_id,
      register_id: register.id,
      cashier_user_id: cashierUserId,
      ...(order.customer_id ? { customer_id: order.customer_id } : {}),
      receipt_no: order.order_number,
      register_sequence: register.nextSequence,
      // Reports already understand these channel values; nothing downstream
      // needs teaching about orders.
      channel: order.fulfilment,
      status: 'completed',
      subtotal_minor: subtotal.toString(),
      discount_minor: '0',
      tax_minor: taxTotal.toString(),
      tip_minor: '0',
      total_minor: total.toString(),
      tax_exempt: false,
      device_time: now.toISOString(),
      completed_at: now.toISOString(),
      lines: saleLines,
      // A completed sale with a non-zero total needs a tender, and rightly so.
      // A pickup is paid at the counter and whoever hands it over says how; a
      // delivery was paid online and carries that payment.
      payments: [{ ...payment, change_minor: '0', tip_minor: '0', device_time: now.toISOString() }],
      age_verifications: [],
    });

    await this.sales.intake(tx, sale);

    return { saleId, registerId: register.id };
  }

  /**
   * The catalog item a delivery fee rings up as: one per organization, holding
   * no stock, never listed online. Created the first time a delivery completes.
   */
  private async deliveryFeeVariant(tx: PoolClient): Promise<string> {
    const { rows: existing } = await tx.query<{ id: string }>(
      `SELECT id FROM product_variants WHERE upper(sku) = $1`,
      [DELIVERY_FEE_SKU],
    );
    if (existing[0]) return existing[0].id;

    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('delivery_fee_item:' || current_setting('app.org_id'), 0))`);
    const { rows: again } = await tx.query<{ id: string }>(`SELECT id FROM product_variants WHERE upper(sku) = $1`, [
      DELIVERY_FEE_SKU,
    ]);
    if (again[0]) return again[0].id;

    const { rows: products } = await tx.query<{ id: string }>(
      // Inactive, so it stays off the registers and out of catalog lists: it is
      // rung up only here, by the system.
      `INSERT INTO products (org_id, name, short_name, description, track_inventory, tags, status)
       VALUES (current_setting('app.org_id')::uuid, 'Delivery fee', 'Delivery',
               'What a customer paid for delivery. Created by the system; holds no stock.', false, '{system}',
               'inactive')
       RETURNING id`,
    );
    const { rows: variants } = await tx.query<{ id: string }>(
      `INSERT INTO product_variants (org_id, product_id, sku, is_default, status)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, true, 'inactive')
       RETURNING id`,
      [products[0]!.id, DELIVERY_FEE_SKU],
    );
    return variants[0]!.id;
  }

  /**
   * The oldest age any line needs, and whether an ID must be seen.
   *
   * Taken from both what the compliance engine decided when the order was
   * placed and the product's own compliance settings -- the same settings the
   * register prompts from -- and the stricter of the two wins. A rule that did
   * not happen to mention age should not let a nicotine product leave without
   * the ID check the counter would have asked for.
   */
  private async ageRequirement(
    tx: PoolClient,
    orderId: string,
  ): Promise<{ minimumAge: number | null; idRequired: boolean }> {
    const { rows } = await tx.query<{ minimum_age: number | null; id_required: boolean | null }>(
      `SELECT NULLIF(max(GREATEST(COALESCE(d.minimum_age, 0), COALESCE(pc.minimum_age, 0))), 0) AS minimum_age,
              bool_or(COALESCE(d.requires_id_scan, false) OR COALESCE(pc.id_scan_required, false)) AS id_required
       FROM order_lines l
       JOIN product_variants v ON v.id = l.variant_id
       LEFT JOIN product_compliance pc ON pc.product_id = v.product_id
       LEFT JOIN compliance_decisions d ON d.order_id = l.order_id AND d.variant_id = l.variant_id
       WHERE l.order_id = $1 AND l.removed_at IS NULL`,
      [orderId],
    );
    const row = rows[0];
    return {
      minimumAge: row?.minimum_age === null || row?.minimum_age === undefined ? null : Number(row.minimum_age),
      idRequired: row?.id_required === true,
    };
  }

  /**
   * Work out an order's subtotal, tax and total from its remaining lines, and
   * its delivery fee.
   *
   * Called when the order is placed, when a line comes off, and again at the
   * moment of sale, so the figure a customer is shown, the figure staff collect
   * and the figure the books record are the same calculation.
   */
  private async recomputeTotals(
    tx: PoolClient,
    orderId: string,
    storeId: string,
    fulfilment: OrderFulfilment,
  ): Promise<{ subtotal: bigint; tax: bigint; total: bigint }> {
    const { rows: lines } = await tx.query<{
      line_total_minor: string;
      tax_category_id: string | null;
      delivery_fee_minor: string;
    }>(
      `SELECT l.line_total_minor::text, p.tax_category_id, o.delivery_fee_minor::text
       FROM order_lines l
       JOIN orders o ON o.id = l.order_id
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE l.order_id = $1 AND l.removed_at IS NULL`,
      [orderId],
    );
    const rates = await taxRatesByCategory(tx, storeId, fulfilment);

    let subtotal = 0n;
    let tax = 0n;
    const chargeLines = [];
    for (const line of lines) {
      const taxable = money(line.line_total_minor);
      const lineRates = rates.get(line.tax_category_id ?? '') ?? [];
      subtotal += taxable;
      tax += taxForLine(taxable, lineRates).tax;
      chargeLines.push({ amount: taxable, rates: lineRates });
    }
    const fee = money(lines[0]?.delivery_fee_minor ?? '0');
    tax += taxForCharge(fee, chargeLines).tax;

    const { rows } = await tx.query<{ total_minor: string }>(
      `UPDATE orders
          SET subtotal_minor = $2::bigint,
              tax_minor      = $3::bigint,
              total_minor    = $2::bigint + $3::bigint - discount_minor + delivery_fee_minor
        WHERE id = $1
      RETURNING total_minor::text`,
      [orderId, subtotal.toString(), tax.toString()],
    );
    return { subtotal, tax, total: BigInt(rows[0]!.total_minor) };
  }

  private async lockOrder(tx: PoolClient, id: string): Promise<LockedOrder> {
    const { rows } = await tx.query<LockedOrder>(
      `SELECT id, store_id, order_number, customer_id, fulfilment, status, delivery_fee_minor::text
       FROM orders WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const order = rows[0];
    if (!order) throw ApiException.notFound('order');
    return order;
  }

  private async event(
    tx: PoolClient,
    orderId: string,
    from: OrderStatus | null,
    to: OrderStatus,
    options: {
      actorUserId?: string | undefined;
      actorType?: string | undefined;
      reason?: string | undefined;
      correlationId?: string | undefined;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO order_events
         (org_id, order_id, from_status, to_status, actor_user_id, actor_type, reason, correlation_id)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
      [
        orderId,
        from,
        to,
        options.actorUserId ?? null,
        options.actorType ?? 'staff',
        options.reason ?? null,
        options.correlationId ?? null,
      ],
    );
  }

  /**
   * The register an online sale is numbered on: one per store, owned by the
   * server, never signed into by a device.
   *
   * Not a counter register, however convenient that would be. A register
   * numbers its own sales offline from a counter it keeps on the device, and
   * `sales_register_seq_key` refuses a second sale with the same number. An
   * online sale that took "the highest number so far, plus one" on a counter
   * register would therefore take the number the phone is about to use, and
   * the phone's own sale -- a real one, already paid for -- would be refused on
   * upload as a non-retryable conflict and never arrive. Online sales get their
   * own register, so neither side can ever reach for the other's numbers.
   *
   * Created on first use. The row is locked while the next number is worked
   * out, so two handovers at the same moment cannot both claim it.
   */
  private async onlineRegister(
    tx: PoolClient,
    storeId: string,
  ): Promise<{ id: string; nextSequence: number }> {
    await tx.query(
      `INSERT INTO registers (org_id, store_id, code, name, config)
       VALUES (current_setting('app.org_id')::uuid, $1, 'ONLINE', 'Online orders',
               '{"kind": "online"}'::jsonb)
       ON CONFLICT (store_id, code) DO NOTHING`,
      [storeId],
    );

    const { rows } = await tx.query<{ id: string; kind: string | null }>(
      `SELECT id, config->>'kind' AS kind FROM registers
       WHERE store_id = $1 AND code = 'ONLINE'
       FOR UPDATE`,
      [storeId],
    );
    const register = rows[0];
    if (!register || register.kind !== 'online') {
      // A till someone named ONLINE by hand. Sharing its numbers is exactly the
      // collision this register exists to prevent, so refuse rather than guess.
      throw new ApiException(
        'conflict',
        'a counter register in this store is coded ONLINE — rename it so online orders can be numbered separately',
        { retryable: false },
      );
    }

    const { rows: sequence } = await tx.query<{ next: string }>(
      `SELECT (COALESCE(max(register_sequence), 0) + 1)::text AS next
       FROM sales WHERE register_id = $1`,
      [register.id],
    );
    return { id: register.id, nextSequence: Number(sequence[0]!.next) };
  }

  /**
   * The price the customer pays, taken from the catalog at the moment of
   * ordering and then frozen on the line.
   *
   * An online price override wins where one is set; otherwise it is whatever
   * the register would charge, which is what stops the website and the counter
   * disagreeing in front of the customer.
   */
  private async priceLines(tx: PoolClient, storeId: string, lines: readonly PlaceOrderLine[]) {
    const { rows } = await tx.query<{
      variant_id: string;
      description: string;
      upc_snapshot: string;
      unit_price_minor: string | null;
    }>(
      // `sku` is the UPC. Since items started being created with one code
      // entered once, that field holds the scanned number, and the catalog's
      // own UPC column reads it too -- an order showing a different "UPC" for
      // the same item than the catalog does would be two definitions of one
      // word.
      `SELECT v.id AS variant_id,
              p.name || COALESCE(' — ' || v.variant_name, '') AS description,
              v.sku AS upc_snapshot,
              COALESCE(sl.online_price_minor, pr.price_minor)::text AS unit_price_minor
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN storefront_listings sl ON sl.variant_id = v.id
       LEFT JOIN LATERAL (
         SELECT price_minor FROM variant_prices
         WHERE variant_id = v.id AND (store_id = $2 OR store_id IS NULL)
           AND kind = 'regular' AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY store_id NULLS LAST, effective_from DESC LIMIT 1
       ) pr ON true
       WHERE v.id = ANY($1::uuid[])`,
      [lines.map((line) => line.variant_id), storeId],
    );

    const byVariant = new Map(rows.map((row) => [row.variant_id, row]));

    return lines.map((line) => {
      const row = byVariant.get(line.variant_id);
      if (!row) throw ApiException.notFound('item');
      if (row.unit_price_minor == null) {
        // Selling at a price nobody set is how a shop loses money quietly --
        // the same rule `CatalogService.scan` already enforces at the counter.
        throw new ApiException(
          'conflict',
          `${row.description} has no price set and cannot be ordered`,
          { retryable: false },
        );
      }
      const unit = BigInt(row.unit_price_minor);
      const total = (unit * scaledQuantity(line.quantity)) / 1000n;
      return {
        variant_id: line.variant_id,
        quantity: line.quantity,
        unit_price_minor: unit.toString(),
        line_total_minor: total.toString(),
        description: row.description,
        upc_snapshot: row.upc_snapshot,
      };
    });
  }

  /**
   * Where the sale happens, for the compliance engine. For pickup that is the
   * shop, down to its county: rules can be scoped that narrowly, and a rule
   * the location never mentions a county for could never match.
   */
  private async jurisdictionFor(tx: PoolClient, storeId: string): Promise<JurisdictionContext> {
    const { rows } = await tx.query<{
      country: string | null;
      region: string | null;
      county: string | null;
      city: string | null;
    }>(`SELECT country, region, county, city FROM stores WHERE id = $1`, [storeId]);
    const store = rows[0];
    return {
      country: store?.country ?? null,
      region: store?.region ?? null,
      county: store?.county ?? null,
      city: store?.city ?? null,
      storeId,
    };
  }

  /**
   * `HH01-260916-001`: the store, the shop's own date, and a count within it.
   *
   * The shop's date, not the server's. A Texas shop's 10 p.m. order belongs to
   * that evening, even though it is already tomorrow in UTC.
   *
   * The year is in it because a number has to stay unique for good:
   * `orders_number_key` refuses a repeat. With only month and day, the first
   * order on the same date next year would repeat this year's first number and
   * be refused -- and since a refused insert rolls back, so would every retry,
   * leaving the website unable to take an order all day.
   *
   * Counted from the numbers themselves, under a per-store lock, so two
   * checkouts in the same instant cannot both take the same one. An advisory
   * lock rather than a lock on the store row, which every counter sale's
   * foreign key check would otherwise have to queue behind.
   */
  private async nextOrderNumber(tx: PoolClient, storeId: string): Promise<string> {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('order_number:' || $1::text, 0))`,
      [storeId],
    );
    const { rows } = await tx.query<{ prefix: string; taken: string }>(
      `WITH today AS (
         SELECT s.id, s.code || '-' || to_char(now() AT TIME ZONE s.timezone, 'YYMMDD') || '-' AS prefix
         FROM stores s WHERE s.id = $1
       )
       SELECT t.prefix,
              (SELECT count(*) FROM orders o
                WHERE o.store_id = t.id AND o.order_number LIKE t.prefix || '%')::text AS taken
       FROM today t`,
      [storeId],
    );
    const today = rows[0];
    if (!today) throw ApiException.notFound('store');
    return `${today.prefix}${String(Number(today.taken) + 1).padStart(3, '0')}`;
  }

  private async load(tx: PoolClient, id: string): Promise<Order> {
    const { rows } = await tx.query<Omit<Order, 'lines' | 'events' | 'minimum_age' | 'id_required' | 'delivery' | 'payment'>>(
      `SELECT o.id, o.store_id, o.order_number, o.customer_id, o.guest_name, o.guest_email,
              o.guest_phone, o.fulfilment, o.status,
              o.subtotal_minor::text, o.discount_minor::text, o.tax_minor::text,
              o.delivery_fee_minor::text, o.total_minor::text,
              o.pickup_from, o.pickup_to, o.note, o.resolution_note, o.sale_id,
              o.placed_via, o.age_attested_at,
              o.placed_at, o.accepted_at, o.ready_at, o.completed_at, o.cancelled_at,
              COALESCE(c.first_name || ' ' || c.last_name, o.guest_name) AS customer_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1`,
      [id],
    );
    const order = rows[0];
    if (!order) throw ApiException.notFound('order');

    // Removed lines come back too. A customer who ordered four and collected
    // three should be able to see that happened, and so should whoever answers
    // the phone about it -- filtering them out here would hide it everywhere.
    const { rows: lines } = await tx.query<OrderLine>(
      `SELECT id, variant_id, quantity::text, unit_price_minor::text, line_total_minor::text,
              description, upc_snapshot, removed_at, removed_reason
       FROM order_lines WHERE order_id = $1 ORDER BY created_at`,
      [id],
    );
    const { rows: events } = await tx.query<OrderEvent>(
      `SELECT from_status, to_status, actor_type, reason, created_at
       FROM order_events WHERE order_id = $1 ORDER BY created_at`,
      [id],
    );
    const { rows: deliveries } = await tx.query<OrderDelivery>(
      `SELECT provider, recipient_name, recipient_phone, address_line1, address_line2, city, region,
              postal_code, dropoff_instructions, external_delivery_id, provider_status, tracking_url,
              support_reference, driver_first_name, courier_fee_minor::text, requested_at,
              estimated_pickup_at, estimated_dropoff_at, picked_up_at, dropped_off_at, cancellation_reason
       FROM order_deliveries WHERE order_id = $1`,
      [id],
    );
    const { rows: payments } = await tx.query<OrderPayment>(
      `SELECT provider, status, amount_minor::text, card_brand, card_last4, (provider = 'test') AS test
       FROM order_payments WHERE order_id = $1
       ORDER BY (status IN ('authorized', 'captured')) DESC, created_at DESC LIMIT 1`,
      [id],
    );
    const requirement = await this.ageRequirement(tx, id);

    return {
      ...order,
      minimum_age: requirement.minimumAge,
      id_required: requirement.idRequired,
      lines,
      events,
      delivery: deliveries[0] ?? null,
      payment: payments[0] ?? null,
    };
  }
}

interface LockedOrder {
  id: string;
  store_id: string;
  order_number: string;
  customer_id: string | null;
  fulfilment: OrderFulfilment;
  status: OrderStatus;
  delivery_fee_minor: string;
}

/** `numeric(14,3)` as a string, scaled to thousandths, so money never meets a float. */
function scaledQuantity(quantity: string): bigint {
  const [whole, fraction = ''] = quantity.trim().split('.');
  return BigInt(`${whole}${fraction.padEnd(3, '0').slice(0, 3)}`);
}

export function describeProblems(problems: readonly { variantId: string; reason: string }[]): string {
  const counts = problems.reduce<Record<string, number>>((acc, problem) => {
    acc[problem.reason] = (acc[problem.reason] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([reason, n]) =>
      reason === 'insufficient_stock'
        ? `${n} item${n === 1 ? '' : 's'} no longer in stock`
        : reason === 'not_listed'
          ? `${n} item${n === 1 ? '' : 's'} no longer available online`
          : reason === 'over_limit'
            ? `${n} item${n === 1 ? '' : 's'} over the limit per order`
            : `${n} item${n === 1 ? '' : 's'} not available for this collection method`,
    )
    .join('; ');
}
