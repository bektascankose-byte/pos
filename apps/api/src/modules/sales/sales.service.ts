import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { SaleInput, SaleVoidInput } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { InventoryRepository } from '../inventory/inventory.repository.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { RetryableIntakeError } from '../../platform/errors/retryable-intake.js';

export type IntakeResult = 'accepted' | 'duplicate';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Record a completed sale.
   *
   * One transaction writes the sale, its lines, its tenders, its age checks, the
   * stock movements and the cash drawer movement. Either all of it lands or none
   * of it does. Stock must never be deducted by a sale that then fails to
   * commit, and a sale must never exist without the stock movement that explains
   * where the product went.
   *
   * Intake is `ON CONFLICT DO NOTHING` on the register generated id. Zero rows
   * back means it already existed, which means this is a duplicate delivery,
   * which is a success. **Duplicate submission is structurally incapable of
   * becoming a duplicate sale**, and that property does not depend on the
   * network behaving, on retries being polite, or on anyone remembering to
   * check first.
   */
  async intake(tx: PoolClient, sale: SaleInput, deviceId?: string): Promise<IntakeResult> {
    const completedAt = sale.completed_at ?? sale.device_time;

    // The register's arithmetic, checked but not enforced. See below.
    const variance = this.computeVariance(sale);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO sales
         (id, org_id, store_id, register_id, device_id, session_id, cashier_user_id,
          customer_id, receipt_no, register_sequence, channel, status,
          subtotal_minor, discount_minor, tax_minor, tip_minor, total_minor,
          cost_total, tax_exempt, tax_exempt_reason, note,
          device_time, completed_at, synced_at, price_variance_minor)
       VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now(), $23)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        sale.id,
        sale.store_id,
        sale.register_id,
        deviceId ?? sale.device_id ?? null,
        sale.session_id ?? null,
        sale.cashier_user_id,
        sale.customer_id ?? null,
        sale.receipt_no,
        sale.register_sequence,
        sale.channel,
        sale.status,
        sale.subtotal_minor.toString(),
        sale.discount_minor.toString(),
        sale.tax_minor.toString(),
        sale.tip_minor.toString(),
        sale.total_minor.toString(),
        this.totalCost(sale),
        sale.tax_exempt,
        sale.tax_exempt_reason ?? null,
        sale.note ?? null,
        sale.device_time,
        sale.status === 'completed' ? completedAt : null,
        variance.toString(),
      ],
    );

    if (rows.length === 0) return 'duplicate';

    await this.insertLines(tx, sale);
    await this.insertPayments(tx, sale);
    await this.insertAgeVerifications(tx, sale, deviceId);

    // Parked sales have not sold anything yet. A held basket must not deduct
    // stock, or a cashier parking a transaction would make the shop's inventory
    // wrong for as long as it sits there.
    if (sale.status === 'completed') {
      await this.postStockMovements(tx, sale, completedAt);
      await this.postCashMovements(tx, sale);
    }

    if (variance !== 0n) {
      // Not a rejection. The money already moved; the discrepancy is recorded
      // and surfaced rather than hidden by refusing the record.
      this.logger.warn(
        { saleId: sale.id, receiptNo: sale.receipt_no, varianceMinor: variance.toString() },
        'sale totals do not match the sum of its lines',
      );
      await this.audit.record(tx, {
        action: 'sale.total_variance',
        entityType: 'sale',
        entityId: sale.id,
        actorUserId: sale.cashier_user_id,
        storeId: sale.store_id,
        newValue: { variance_minor: variance.toString(), claimed_total: sale.total_minor.toString() },
      });
    }

    return 'accepted';
  }

  private async insertLines(tx: PoolClient, sale: SaleInput): Promise<void> {
    for (const line of sale.lines) {
      await tx.query(
        `INSERT INTO sale_lines
           (id, org_id, sale_id, line_no, variant_id, description, sku_snapshot,
            barcode_scanned, quantity, unit_price_minor, original_price_minor,
            price_overridden, override_by, override_reason, discount_minor,
            tax_minor, total_minor, unit_cost, tax_snapshot, promotion_ids,
            compliance_snapshot)
         VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,
                 $11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO NOTHING`,
        [
          line.id,
          sale.id,
          line.line_no,
          line.variant_id,
          line.description,
          line.sku_snapshot,
          line.barcode_scanned ?? null,
          line.quantity,
          line.unit_price_minor.toString(),
          line.original_price_minor.toString(),
          line.price_overridden,
          line.override_by ?? null,
          line.override_reason ?? null,
          line.discount_minor.toString(),
          line.tax_minor.toString(),
          line.total_minor.toString(),
          line.unit_cost,
          JSON.stringify(line.tax_snapshot),
          line.promotion_ids,
          JSON.stringify(line.compliance_snapshot),
        ],
      );
    }
  }

  private async insertPayments(tx: PoolClient, sale: SaleInput): Promise<void> {
    for (const payment of sale.payments) {
      await tx.query(
        `INSERT INTO payments
           (id, org_id, sale_id, method, status, amount_minor, tendered_minor,
            change_minor, tip_minor, provider, provider_payment_id, provider_token,
            card_last4, card_brand, entry_mode, auth_code, terminal_serial,
            captured_at, device_time)
         VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,
                 $11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          payment.id,
          sale.id,
          payment.method,
          payment.status,
          payment.amount_minor.toString(),
          payment.tendered_minor?.toString() ?? null,
          payment.change_minor.toString(),
          payment.tip_minor.toString(),
          payment.provider ?? null,
          payment.provider_payment_id ?? null,
          payment.provider_token ?? null,
          payment.card_last4 ?? null,
          payment.card_brand ?? null,
          payment.entry_mode ?? null,
          payment.auth_code ?? null,
          payment.terminal_serial ?? null,
          payment.status === 'captured' ? payment.device_time : null,
          payment.device_time,
        ],
      );
    }
  }

  private async insertAgeVerifications(
    tx: PoolClient,
    sale: SaleInput,
    deviceId?: string,
  ): Promise<void> {
    for (const check of sale.age_verifications) {
      await tx.query(
        `INSERT INTO age_verifications
           (id, org_id, store_id, register_id, sale_id, sale_line_id, method, result,
            minimum_age_applied, provider, provider_token, employee_user_id,
            device_id, verified_at)
         VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [
          check.id,
          sale.store_id,
          sale.register_id,
          sale.id,
          check.sale_line_id ?? null,
          check.method,
          check.result,
          check.minimum_age_applied,
          check.provider ?? null,
          check.provider_token ?? null,
          sale.cashier_user_id,
          deviceId ?? sale.device_id ?? null,
          check.verified_at,
        ],
      );
    }
  }

  /**
   * Deduct stock, one ledger entry per line.
   *
   * The ledger id is the sale line's own id and `occurred_at` is the sale's
   * completion time. Both are fixed at the moment of sale on the register, so a
   * replayed upload produces the identical primary key and conflicts instead of
   * moving stock twice.
   *
   * This is why the pair matters: `inventory_ledger` is partitioned by month, so
   * its key is `(id, occurred_at)`. Reusing the id while letting `occurred_at`
   * default to `now()` would not conflict at all.
   */
  private async postStockMovements(
    tx: PoolClient,
    sale: SaleInput,
    completedAt: string,
  ): Promise<void> {
    await this.inventory.post(
      tx,
      sale.lines.map((line) => ({
        storeId: sale.store_id,
        variantId: line.variant_id,
        // A sale of 2 is a stock movement of -2.
        delta: negate(line.quantity),
        reason: 'sale' as const,
        unitCost: line.unit_cost,
        referenceType: 'sale_line',
        referenceId: line.id,
        actorUserId: sale.cashier_user_id,
        ledgerId: line.id,
        occurredAt: completedAt,
      })),
    );
  }

  /**
   * Cash tenders move the drawer.
   *
   * Only the cash portion, and only the amount, not what was tendered: handing
   * over $50 for a $43 sale puts $43 in the drawer and $7 back in the
   * customer's hand. Counting the tender would make every drawer over by the
   * change given.
   */
  private async postCashMovements(tx: PoolClient, sale: SaleInput): Promise<void> {
    if (!sale.session_id) return;

    for (const payment of sale.payments) {
      if (payment.method !== 'cash' || payment.status !== 'captured') continue;

      await tx.query(
        `INSERT INTO cash_movements
           (id, org_id, session_id, kind, amount_minor, reference_type, reference_id,
            actor_user_id, occurred_at)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, 'sale', $3, 'sale', $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          payment.id,
          sale.session_id,
          payment.amount_minor.toString(),
          sale.id,
          sale.cashier_user_id,
          sale.completed_at ?? sale.device_time,
        ],
      );
    }
  }

  /**
   * Voiding a cash sale takes the money back out of the drawer.
   *
   * Without this the drawer is expected to hold cash that was handed back to
   * the customer, so every voided cash sale makes the count read **over** by
   * its own amount at close. That is worse than a missing feature: over and
   * short are the only signal a manager has, and a cashier who voided a sale
   * and kept the notes would produce a drawer that balances perfectly.
   *
   * Only captured cash reverses. A card sale's void has to go back to the card
   * through the processor, and no payment provider is integrated yet — putting
   * a negative cash movement in for one would move a drawer that never held
   * the money.
   *
   * A closed session cannot be reopened, so a void of a sale from an earlier
   * shift is refused rather than silently posted somewhere it does not belong.
   * The remedy is a refund, which lands in today's drawer where the money
   * actually leaves from.
   */
  private async reverseCashMovements(
    tx: PoolClient,
    saleId: string,
    sessionId: string | null,
    actorUserId: string,
    reason: string,
  ): Promise<void> {
    if (!sessionId) return;

    const { rows: cash } = await tx.query<{ id: string; amount_minor: string }>(
      `SELECT id, amount_minor::text
       FROM payments
       WHERE sale_id = $1 AND method = 'cash' AND status = 'captured'`,
      [saleId],
    );
    if (cash.length === 0) return;

    const { rows: sessionRows } = await tx.query<{ closed_at: Date | null }>(
      `SELECT closed_at FROM cash_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const session = sessionRows[0];
    if (session?.closed_at) {
      throw new ApiException(
        'conflict',
        'the drawer this sale was rung into has already been closed; refund it instead',
        {
          userMessage:
            "That shift is closed. Refund this sale instead, so the money comes out of today's drawer.",
        },
      );
    }

    for (const payment of cash) {
      await tx.query(
        `INSERT INTO cash_movements
           (id, org_id, session_id, kind, amount_minor, reference_type, reference_id,
            actor_user_id, reason, occurred_at)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, 'refund', $3, 'sale_void',
                 $4, $5, $6, now())
         ON CONFLICT (id) DO NOTHING`,
        [
          // Derived from the payment being reversed, so a replayed void cannot
          // take the money out twice.
          reversalId(payment.id),
          sessionId,
          (-BigInt(payment.amount_minor)).toString(),
          saleId,
          actorUserId,
          reason,
        ],
      );
    }
  }

  /**
   * Difference between the total the register claimed and the total its own
   * lines add up to. Zero on every healthy sale.
   *
   * A non zero value means the register's arithmetic disagrees with itself,
   * which is a bug worth finding — most likely a rounding difference between
   * the Kotlin pricing engine and this one, which is exactly what the
   * conformance suite exists to prevent.
   */
  private computeVariance(sale: SaleInput): bigint {
    const lineSum = sale.lines.reduce((acc, l) => acc + l.total_minor, 0n);
    const expected = lineSum + sale.tip_minor;
    return sale.total_minor - expected;
  }

  private totalCost(sale: SaleInput): string {
    const total = sale.lines.reduce((acc, line) => {
      const qty = Math.abs(Number.parseFloat(line.quantity));
      return acc + qty * Number.parseFloat(line.unit_cost);
    }, 0);
    return total.toFixed(6);
  }

  /**
   * Void a sale.
   *
   * A void is a new state, never a deletion: `guard_no_delete` makes deletion
   * impossible at the database level. The stock comes back through a new ledger
   * entry rather than by reversing the original, so the history reads as "sold,
   * then returned" — which is what happened.
   */
  async void(orgId: string, saleId: string, actorUserId: string, reason: string) {
    return this.db.withOrg(orgId, (tx) => this.voidInTx(tx, saleId, actorUserId, reason));
  }

  /**
   * Voiding, inside a caller's transaction.
   *
   * Extracted so a void arriving through the sync batch reverses stock by
   * exactly the same code as one arriving over HTTP. Two implementations of
   * "put the sale's stock back" would drift, and the direction they drift in is
   * a count that is quietly wrong.
   */
  private async voidInTx(
    tx: PoolClient,
    saleId: string,
    actorUserId: string,
    reason: string,
  ) {
    {
      const { rows } = await tx.query<{
        status: string;
        store_id: string;
        session_id: string | null;
        completed_at: Date | null;
      }>(
        `SELECT status, store_id, session_id, completed_at
         FROM sales WHERE id = $1 FOR UPDATE`,
        [saleId],
      );

      const sale = rows[0];
      if (!sale) throw ApiException.notFound('sale');
      if (sale.status === 'voided') {
        throw new ApiException('conflict', 'this sale is already voided', { retryable: false });
      }

      const { rows: lines } = await tx.query<{
        id: string;
        variant_id: string;
        quantity: string;
        unit_cost: string;
        quantity_refunded: string;
      }>(
        `SELECT id, variant_id, quantity::text, unit_cost::text, quantity_refunded::text
         FROM sale_lines WHERE sale_id = $1`,
        [saleId],
      );

      // Refunding part of a sale and then voiding the rest would double count the
      // return. Voiding is for a whole transaction that should not have happened.
      if (lines.some((l) => Number.parseFloat(l.quantity_refunded) > 0)) {
        throw new ApiException(
          'conflict',
          'this sale has already been partly refunded; refund the remainder instead of voiding',
          { userMessage: 'Part of this sale was already refunded. Refund the rest instead.' },
        );
      }

      await tx.query(
        `UPDATE sales SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = $3
         WHERE id = $1`,
        [saleId, actorUserId, reason],
      );

      await this.inventory.post(
        tx,
        lines.map((line) => ({
          storeId: sale.store_id,
          variantId: line.variant_id,
          // Put back exactly what the sale took out.
          delta: line.quantity,
          reason: 'refund' as const,
          unitCost: line.unit_cost,
          referenceType: 'sale_void',
          referenceId: saleId,
          actorUserId,
          note: reason,
        })),
      );

      await this.reverseCashMovements(tx, saleId, sale.session_id, actorUserId, reason);

      await this.audit.record(tx, {
        action: 'sale.void',
        entityType: 'sale',
        entityId: saleId,
        actorUserId,
        storeId: sale.store_id,
        oldValue: { status: sale.status },
        newValue: { status: 'voided', reason },
        reason,
      });

      return { id: saleId, status: 'voided' };
    }
  }

  /**
   * A void that arrived from a register, inside a sync batch.
   *
   * Idempotent on the sale's own status rather than on a separate key. A second
   * delivery finds the sale already voided and reports `duplicate`, which the
   * register treats exactly like `accepted`; nothing is restocked twice, which
   * is the silent drift this path exists to avoid. Who voided it and why is
   * already recorded on the sale row and in the audit log.
   *
   * A missing sale is **retryable, not a rejection**. Entities are ordered
   * inside a batch but not across batches, so a sale whose upload failed while
   * its void succeeded is a normal sequence. Rejecting would dead letter a void
   * for a sale that is about to arrive, leaving a sale standing that a manager
   * already voided at the counter.
   *
   * Authority is the approver's, checked by the sync route before this runs,
   * because the cashier's token is only the transport.
   */
  async intakeVoid(
    tx: PoolClient,
    input: SaleVoidInput,
  ): Promise<'accepted' | 'duplicate'> {
    const { rows } = await tx.query<{ status: string }>(
      `SELECT status FROM sales WHERE id = $1 FOR UPDATE`,
      [input.sale_id],
    );

    const existing = rows[0];
    if (!existing) {
      throw new RetryableIntakeError(
        `sale ${input.sale_id} has not arrived yet; its void waits for it`,
      );
    }
    if (existing.status === 'voided') return 'duplicate';

    await this.voidInTx(tx, input.sale_id, input.approved_by, input.reason);
    return 'accepted';
  }

  async findOne(orgId: string, saleId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT s.*, s.subtotal_minor::text, s.total_minor::text, s.tax_minor::text
         FROM sales s WHERE s.id = $1`,
        [saleId],
      );
      const sale = rows[0];
      if (!sale) throw ApiException.notFound('sale');

      const { rows: lines } = await tx.query(
        `SELECT id, line_no, variant_id, description, sku_snapshot, quantity::text,
                unit_price_minor::text, discount_minor::text, tax_minor::text,
                total_minor::text, quantity_refunded::text
         FROM sale_lines WHERE sale_id = $1 ORDER BY line_no`,
        [saleId],
      );
      const { rows: payments } = await tx.query(
        `SELECT id, method, status, amount_minor::text, tendered_minor::text,
                change_minor::text, card_last4, card_brand
         FROM payments WHERE sale_id = $1`,
        [saleId],
      );

      return { ...sale, lines, payments };
    });
  }

  async list(
    orgId: string,
    filter: {
      storeId?: string | undefined;
      registerId?: string | undefined;
      cashierUserId?: string | undefined;
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
    },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, receipt_no, store_id, register_id, cashier_user_id, status,
                total_minor::text, tax_minor::text, completed_at, channel
         FROM sales
         WHERE ($1::uuid IS NULL OR store_id = $1)
           AND ($2::uuid IS NULL OR register_id = $2)
           AND ($3::uuid IS NULL OR cashier_user_id = $3)
           AND ($4::text  IS NULL OR status::text = $4)
           AND ($5::timestamptz IS NULL OR completed_at >= $5)
           AND ($6::timestamptz IS NULL OR completed_at < $6)
         ORDER BY completed_at DESC NULLS LAST
         LIMIT $7`,
        [
          filter.storeId ?? null,
          filter.registerId ?? null,
          filter.cashierUserId ?? null,
          filter.status ?? null,
          filter.from ?? null,
          filter.to ?? null,
          filter.limit,
        ],
      );
      return { data: rows, next_cursor: null };
    });
  }
}

/** Flip the sign of a decimal string without going through a float. */
function negate(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`;
}

/**
 * The id of the cash movement that reverses a payment.
 *
 * Derived from the payment's own id rather than generated, so it is the same
 * every time: a replayed void hits `ON CONFLICT (id) DO NOTHING` and the money
 * comes out of the drawer exactly once. A random id would take it out again on
 * every redelivery, and a register retries without knowing whether the last
 * attempt landed.
 *
 * A name based UUID (RFC 4122 v5 shape) over a fixed namespace, so two
 * different payments can never collide into one reversal.
 */
function reversalId(paymentId: string): string {
  const NAMESPACE = 'a9f1c3d2-5e7b-4a86-9c40-2f1d8b6e0a33';
  const bytes = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(paymentId)
    .digest();

  // Version 5, RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
