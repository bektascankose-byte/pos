import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  assertTransition,
  InvalidOrderTransition,
  isTerminal,
  movesStock,
  saleInput,
  type Order,
  type OrderEvent,
  type OrderFulfilment,
  type OrderLine,
  type OrderQueueEntry,
  type OrderStatus,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { OutboxService } from '../../platform/outbox/outbox.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { AvailabilityService, type RequestedLine } from '../storefront/availability.service.js';
import { ComplianceService, type JurisdictionContext } from '../compliance/compliance.service.js';
import { SalesService } from '../sales/sales.service.js';

/** How a pickup order was paid at the counter. Online payment arrives in a later phase. */
export type TenderMethod = 'cash' | 'card' | 'other';

export interface PlaceOrderLine {
  variant_id: string;
  quantity: string;
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
}

/**
 * Online orders, and the queue staff work them from.
 *
 * The one rule that shapes everything here: **an order claims stock, it does
 * not move it.** Nothing touches the inventory ledger until handoff, and at
 * handoff the movement and the sale that explains it are written in the same
 * transaction. An order cancelled at any point before that simply stops
 * existing as a claim; no compensating movement is needed because none was
 * ever made.
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
  ) {}

  /**
   * Place an order.
   *
   * Availability, compliance, the order, its lines, its first event and the
   * outbox message all land in one transaction or none of them do. That is the
   * whole design: an order that exists without its event never reaches the
   * register, and an event for an order that rolled back sends a cashier
   * looking for a sale nobody made.
   *
   * Both gates are re-run here even though the storefront checked them while
   * the customer was shopping. Stock moves at the counter and rules change;
   * the only check worth trusting is the one inside the transaction that
   * writes the order.
   */
  async place(orgId: string, input: PlaceOrderInput) {
    if (input.lines.length === 0) {
      throw new ApiException('validation_failed', 'an order needs at least one item', {
        retryable: false,
      });
    }

    const outcome = await this.db.withOrg(orgId, async (tx): Promise<{ refusal: string } | { order: Order }> => {
      const jurisdiction = await this.jurisdictionFor(tx, input.store_id);
      const asOf = new Date();
      const variantIds = input.lines.map((line) => line.variant_id);

      // Compliance first: an item that may not be sold at all should say so,
      // rather than being reported as merely out of stock.
      const decisions = await this.compliance.checkCartTx(
        tx,
        input.fulfilment === 'pickup' ? 'pickup' : 'delivery',
        jurisdiction,
        variantIds,
        asOf,
      );
      const refused = decisions.filter((decision) => !decision.allowed);
      if (refused.length > 0) {
        // Recorded even though the order is refused -- especially then. "Why
        // could this customer not buy this" is the question that gets asked.
        // Returned rather than thrown, so this transaction commits the record:
        // throwing here would roll the evidence back along with the order.
        await this.compliance.record(tx, {
          channel: input.fulfilment === 'pickup' ? 'pickup' : 'delivery',
          jurisdiction,
          asOf,
          decisions,
        });
        return { refusal: refused.map((decision) => decision.reason).join(' ') };
      }

      const problems = await this.availability.checkTx(
        tx,
        input.store_id,
        input.fulfilment,
        input.lines.map((line): RequestedLine => ({
          variantId: line.variant_id,
          quantity: line.quantity,
        })),
      );
      if (problems.length > 0) {
        throw new ApiException('conflict', describeProblems(problems), { retryable: false });
      }

      const priced = await this.priceLines(tx, input.store_id, input.lines);
      const subtotal = priced.reduce((sum, line) => sum + BigInt(line.line_total_minor), 0n);
      const orderNumber = await this.nextOrderNumber(tx, input.store_id);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO orders
           (org_id, store_id, order_number, customer_id, guest_name, guest_email, guest_phone,
            fulfilment, status, subtotal_minor, total_minor, pickup_from, pickup_to, note,
            correlation_id)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, 'placed',
                 $8, $8, $9::timestamptz, $10::timestamptz, $11, $12)
         RETURNING id`,
        [
          input.store_id,
          orderNumber,
          input.customer_id ?? null,
          input.guest_name ?? null,
          input.guest_email ?? null,
          input.guest_phone ?? null,
          input.fulfilment,
          // Tax is computed at handoff by the same path a counter sale uses,
          // rather than guessed here and then disagreed with.
          subtotal.toString(),
          input.pickup_from ?? null,
          input.pickup_to ?? null,
          input.note ?? null,
          input.correlation_id ?? null,
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

      await this.compliance.record(tx, {
        orderId,
        channel: input.fulfilment === 'pickup' ? 'pickup' : 'delivery',
        jurisdiction,
        asOf,
        decisions,
      });

      await this.event(tx, orderId, null, 'placed', {
        actorType: 'customer',
        correlationId: input.correlation_id,
      });

      // What makes the order appear on the register. Written here, delivered
      // by the pump, so a network that is down cannot lose the order.
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
          line_count: priced.length,
          total_minor: subtotal.toString(),
        },
      });

      return { order: await this.loadTx(tx, orderId) };
    });

    if ('refusal' in outcome) {
      throw new ApiException('validation_failed', outcome.refusal, { retryable: false });
    }
    return outcome.order;
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
                round(extract(epoch FROM now() - o.placed_at))::int AS waiting_seconds
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         WHERE o.store_id = $1
           AND o.status IN ('placed', 'accepted', 'preparing', 'ready')
         ORDER BY o.placed_at`,
        [storeId],
      );
      return rows;
    });
  }

  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, (tx) => this.loadTx(tx, id));
  }

  /**
   * Move an order along.
   *
   * Every status change in the system funnels through here so the transition
   * check cannot be skipped by a caller in a hurry, and so every change writes
   * its event and its outbox message without anybody remembering to.
   */
  async transition(
    orgId: string,
    actorUserId: string,
    id: string,
    to: OrderStatus,
    options: {
      reason?: string | undefined;
      correlationId?: string | undefined;
      /** Required when completing: a finished sale must record how it was paid. */
      tender?: TenderMethod | undefined;
    } = {},
  ) {
    return this.db.withOrg(orgId, async (tx) => {
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

      // Handing over is the only transition that moves anything. Everything
      // else is bookkeeping.
      let saleId: string | null = null;
      if (movesStock(to)) {
        if (!options.tender) {
          throw new ApiException(
            'validation_failed',
            'say how the customer paid — a completed sale has to record its tender',
            { retryable: false },
          );
        }
        saleId = await this.writeSale(tx, actorUserId, current, options.tender);
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

      await this.event(tx, id, current.status, to, {
        actorUserId,
        reason: options.reason,
        correlationId: options.correlationId,
      });

      await this.audit.record(tx, {
        action: `order.${to}`,
        entityType: 'order',
        entityId: id,
        actorUserId,
        oldValue: { status: current.status },
        newValue: { status: to, sale_id: saleId },
        reason: options.reason,
      });

      await this.outbox.emit(tx, {
        eventType: 'order.status_changed',
        aggregateType: 'order',
        aggregateId: id,
        storeId: current.store_id,
        correlationId: options.correlationId,
        payload: { order_id: id, from: current.status, to, sale_id: saleId },
      });

      return this.loadTx(tx, id);
    });
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

      const { rows } = await tx.query<{ line_total_minor: string }>(
        `UPDATE order_lines SET removed_at = now(), removed_reason = $3
          WHERE id = $2 AND order_id = $1 AND removed_at IS NULL
        RETURNING line_total_minor::text`,
        [id, lineId, reason],
      );
      if (!rows[0]) throw ApiException.notFound('order line');

      // The total follows the lines. A customer is charged for what they get.
      await tx.query(
        `UPDATE orders
            SET subtotal_minor = subtotal_minor - $2::bigint,
                total_minor    = total_minor - $2::bigint
          WHERE id = $1`,
        [id, rows[0].line_total_minor],
      );

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

  // ------------------------------------------------------------------ private

  /**
   * Write the sale this order became.
   *
   * Reuses `SalesService.intake`, which is what makes a double handoff
   * structurally incapable of producing two sales: the sale id is derived from
   * the order id, and intake is `ON CONFLICT DO NOTHING` on it. Retrying is
   * therefore safe rather than merely unlikely to be needed.
   */
  private async writeSale(
    tx: PoolClient,
    actorUserId: string,
    order: LockedOrder,
    tender: TenderMethod,
  ): Promise<string> {
    const { rows: lines } = await tx.query<{
      variant_id: string;
      quantity: string;
      unit_price_minor: string;
      line_total_minor: string;
      description: string;
      upc_snapshot: string;
    }>(
      `SELECT variant_id, quantity::text, unit_price_minor::text, line_total_minor::text,
              description, upc_snapshot
       FROM order_lines WHERE order_id = $1 AND removed_at IS NULL ORDER BY created_at`,
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

    // v7 ids from Postgres rather than randomUUID: the sale, every line and
    // every tender must satisfy the same uuidV7 rule the register's own writes
    // do, and a line id doubles as its inventory ledger id.
    const { rows: ids } = await tx.query<{ id: string }>(
      `SELECT uuid_generate_v7() AS id FROM generate_series(1, $1)`,
      [lines.length + 2],
    );
    const saleId = ids[0]!.id;
    const paymentId = ids[1]!.id;

    const now = new Date();
    const subtotal = lines.reduce((sum, line) => sum + BigInt(line.line_total_minor), 0n);

    // Parsed, not cast. The register's own sales arrive through this schema and
    // pick up its defaults on the way -- `tax_snapshot` and
    // `compliance_snapshot` among them, both of which the sale_lines table
    // requires. A cast would type-check and then write a null into a NOT NULL
    // column at the one moment that matters, which is exactly what it did.
    const sale = saleInput.parse({
      id: saleId,
      store_id: order.store_id,
      register_id: register.id,
      cashier_user_id: actorUserId,
      ...(order.customer_id ? { customer_id: order.customer_id } : {}),
      receipt_no: order.order_number,
      register_sequence: register.nextSequence,
      // Reports already understand these channel values; nothing downstream
      // needs teaching about orders.
      channel: order.fulfilment,
      status: 'completed',
      subtotal_minor: subtotal.toString(),
      discount_minor: '0',
      // Honestly zero rather than guessed. Tax on online orders is computed by
      // the storefront checkout in a later phase, through the same path the
      // counter uses; inventing a number here would disagree with it.
      tax_minor: '0',
      tip_minor: '0',
      total_minor: subtotal.toString(),
      tax_exempt: false,
      device_time: now.toISOString(),
      completed_at: now.toISOString(),
      lines: lines.map((line, index) => ({
        id: ids[index + 2]!.id,
        line_no: index + 1,
        variant_id: line.variant_id,
        description: line.description,
        sku_snapshot: line.upc_snapshot,
        quantity: line.quantity,
        unit_price_minor: line.unit_price_minor,
        original_price_minor: line.unit_price_minor,
        price_overridden: false,
        discount_minor: '0',
        tax_minor: '0',
        total_minor: line.line_total_minor,
        unit_cost: '0',
      })),
      // A completed sale with a non-zero total needs a tender, and rightly so.
      // Until online payment exists a pickup order is paid at the counter on
      // collection, so whoever hands it over says how.
      payments: [
        {
          id: paymentId,
          method: tender,
          status: 'captured',
          amount_minor: subtotal.toString(),
          change_minor: '0',
          tip_minor: '0',
          device_time: now.toISOString(),
        },
      ],
      age_verifications: [],
    });

    await this.sales.intake(tx, sale);

    return saleId;
  }

  private async lockOrder(tx: PoolClient, id: string): Promise<LockedOrder> {
    const { rows } = await tx.query<LockedOrder>(
      `SELECT id, store_id, order_number, customer_id, fulfilment, status
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
   * The price the customer pays, taken from the catalog at the moment of
   * ordering and then frozen on the line.
   *
   * An online price override wins where one is set; otherwise it is whatever
   * the register would charge, which is what stops the website and the counter
   * disagreeing in front of the customer.
   */
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

  /** Where the sale happens, for the compliance engine. For pickup that is the shop. */
  private async jurisdictionFor(tx: PoolClient, storeId: string): Promise<JurisdictionContext> {
    const { rows } = await tx.query<{
      country: string | null;
      region: string | null;
      city: string | null;
    }>(`SELECT country, region, city FROM stores WHERE id = $1`, [storeId]);
    const store = rows[0];
    return {
      country: store?.country ?? null,
      region: store?.region ?? null,
      city: store?.city ?? null,
      storeId,
    };
  }

  /**
   * A short, human order number.
   *
   * Per store and per day, so it is short enough to read down a phone and
   * still unique. The unique index is what actually guarantees that; this
   * just makes a collision rare rather than relying on it being impossible.
   */
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

  private async loadTx(tx: PoolClient, id: string): Promise<Order> {
    const { rows } = await tx.query<Omit<Order, 'lines' | 'events'>>(
      `SELECT o.*, o.total_minor::text AS total_minor, o.subtotal_minor::text AS subtotal_minor,
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

    return { ...order, lines, events };
  }
}

interface LockedOrder {
  id: string;
  store_id: string;
  order_number: string;
  customer_id: string | null;
  fulfilment: OrderFulfilment;
  status: OrderStatus;
}

/** `numeric(14,3)` as a string, scaled to thousandths, so money never meets a float. */
function scaledQuantity(quantity: string): bigint {
  const [whole, fraction = ''] = quantity.trim().split('.');
  return BigInt(`${whole}${fraction.padEnd(3, '0').slice(0, 3)}`);
}

function describeProblems(problems: readonly { variantId: string; reason: string }[]): string {
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
