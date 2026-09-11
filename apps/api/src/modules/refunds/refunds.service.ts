import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RefundInput } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { InventoryRepository } from '../inventory/inventory.repository.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Record a refund.
   *
   * `quantity_refunded` on the original sale line is the one mutable column in
   * the whole financial schema, and it exists for exactly this: it is what makes
   * refunding four of something that was sold in a quantity of three impossible
   * rather than merely discouraged.
   *
   * The row is locked `FOR UPDATE` before the check, so two registers refunding
   * the same receipt at the same moment serialize instead of both reading three
   * and both allowing three back. Without the lock the constraint would still
   * catch the total, but only after both had already told a customer yes.
   */
  async intake(tx: PoolClient, refund: RefundInput, deviceId?: string): Promise<'accepted' | 'duplicate'> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO refunds
         (id, org_id, store_id, register_id, session_id, original_sale_id, customer_id,
          cashier_user_id, approved_by, receipt_no, reason_code, reason_note,
          subtotal_minor, tax_minor, total_minor, restock, device_time)
       VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               $12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        refund.id,
        refund.store_id,
        refund.register_id,
        refund.session_id ?? null,
        refund.original_sale_id ?? null,
        refund.customer_id ?? null,
        refund.cashier_user_id,
        refund.approved_by ?? null,
        refund.receipt_no,
        refund.reason_code,
        refund.reason_note ?? null,
        refund.subtotal_minor.toString(),
        refund.tax_minor.toString(),
        refund.total_minor.toString(),
        refund.restock,
        refund.device_time,
      ],
    );

    if (rows.length === 0) return 'duplicate';

    await this.consumeOriginalQuantities(tx, refund);
    await this.insertLines(tx, refund);
    await this.insertPayments(tx, refund);
    await this.restock(tx, refund, deviceId);
    await this.postCashMovements(tx, refund);

    await this.audit.record(tx, {
      action: refund.original_sale_id ? 'refund.create' : 'refund.no_receipt',
      entityType: 'refund',
      entityId: refund.id,
      actorUserId: refund.cashier_user_id,
      storeId: refund.store_id,
      registerId: refund.register_id,
      newValue: {
        total_minor: refund.total_minor.toString(),
        original_sale_id: refund.original_sale_id ?? null,
        approved_by: refund.approved_by ?? null,
        lines: refund.lines.length,
      },
      reason: refund.reason_note ?? refund.reason_code,
    });

    return 'accepted';
  }

  /**
   * Claim the refunded quantity against the original lines.
   *
   * Runs before the refund lines are written so that a rejection happens before
   * anything else in this transaction has had an effect.
   */
  private async consumeOriginalQuantities(tx: PoolClient, refund: RefundInput): Promise<void> {
    for (const line of refund.lines) {
      if (!line.sale_line_id) continue;

      const { rows } = await tx.query<{
        quantity: string;
        quantity_refunded: string;
        sale_id: string;
      }>(
        `SELECT quantity::text, quantity_refunded::text, sale_id
         FROM sale_lines WHERE id = $1 FOR UPDATE`,
        [line.sale_line_id],
      );
      const original = rows[0];
      if (!original) {
        throw new ApiException('not_found', `sale line ${line.sale_line_id} does not exist`, {
          retryable: false,
        });
      }

      if (refund.original_sale_id && original.sale_id !== refund.original_sale_id) {
        throw new ApiException(
          'validation_failed',
          'a refund line references a sale line from a different sale',
          { retryable: false },
        );
      }

      const sold = Math.abs(Number.parseFloat(original.quantity));
      const alreadyRefunded = Number.parseFloat(original.quantity_refunded);
      const requested = Math.abs(Number.parseFloat(line.quantity));

      if (alreadyRefunded + requested > sold + 1e-9) {
        const remaining = sold - alreadyRefunded;
        throw new ApiException(
          'conflict',
          `cannot refund ${requested} of ${line.description}: ${sold} were sold and ` +
            `${alreadyRefunded} already refunded`,
          {
            userMessage:
              remaining > 0
                ? `Only ${remaining} of ${line.description} can still be refunded.`
                : `${line.description} has already been fully refunded.`,
            retryable: false,
          },
        );
      }

      await tx.query(
        `UPDATE sale_lines SET quantity_refunded = quantity_refunded + $2 WHERE id = $1`,
        [line.sale_line_id, Math.abs(Number.parseFloat(line.quantity)).toString()],
      );
    }
  }

  private async insertLines(tx: PoolClient, refund: RefundInput): Promise<void> {
    for (const line of refund.lines) {
      await tx.query(
        `INSERT INTO refund_lines
           (id, org_id, refund_id, sale_line_id, variant_id, description, quantity,
            unit_price_minor, tax_minor, total_minor, unit_cost, restocked, condition)
         VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          line.id,
          refund.id,
          line.sale_line_id ?? null,
          line.variant_id,
          line.description,
          Math.abs(Number.parseFloat(line.quantity)).toString(),
          line.unit_price_minor.toString(),
          line.tax_minor.toString(),
          line.total_minor.toString(),
          line.unit_cost,
          line.restocked,
          line.condition ?? null,
        ],
      );
    }
  }

  private async insertPayments(tx: PoolClient, refund: RefundInput): Promise<void> {
    for (const payment of refund.payments) {
      await tx.query(
        `INSERT INTO payments
           (id, org_id, refund_id, method, status, amount_minor, provider,
            provider_payment_id, provider_token, card_last4, card_brand,
            captured_at, device_time)
         VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          payment.id,
          refund.id,
          payment.method,
          payment.status,
          payment.amount_minor.toString(),
          payment.provider ?? null,
          payment.provider_payment_id ?? null,
          payment.provider_token ?? null,
          payment.card_last4 ?? null,
          payment.card_brand ?? null,
          payment.status === 'captured' ? payment.device_time : null,
          payment.device_time,
        ],
      );
    }
  }

  /**
   * Put stock back, but only for lines that are actually resellable.
   *
   * An opened drink is refunded and not restocked. Restocking it anyway would
   * make the count drift by exactly the number of damaged returns, which is the
   * kind of slow error that takes a full physical count to find.
   */
  private async restock(tx: PoolClient, refund: RefundInput, deviceId?: string): Promise<void> {
    const restockable = refund.lines.filter((l) => refund.restock && l.restocked);
    if (restockable.length === 0) return;

    await this.inventory.post(
      tx,
      restockable.map((line) => ({
        storeId: refund.store_id,
        variantId: line.variant_id,
        delta: Math.abs(Number.parseFloat(line.quantity)).toString(),
        reason: 'refund' as const,
        unitCost: line.unit_cost,
        referenceType: 'refund_line',
        referenceId: line.id,
        actorUserId: refund.cashier_user_id,
        deviceId,
        ledgerId: line.id,
        // Fixed at the moment of refund on the register, so a replay lands on
        // the same (id, occurred_at) key and conflicts instead of restocking
        // the same item twice.
        occurredAt: refund.device_time,
      })),
    );
  }

  /** Cash refunds take money out of the drawer. */
  private async postCashMovements(tx: PoolClient, refund: RefundInput): Promise<void> {
    if (!refund.session_id) return;

    for (const payment of refund.payments) {
      if (payment.method !== 'cash' || payment.status !== 'captured') continue;

      await tx.query(
        `INSERT INTO cash_movements
           (id, org_id, session_id, kind, amount_minor, reference_type, reference_id,
            actor_user_id, occurred_at)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, 'refund', $3, 'refund', $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          payment.id,
          refund.session_id,
          // Negative: money leaves the drawer.
          (-payment.amount_minor).toString(),
          refund.id,
          refund.cashier_user_id,
          refund.device_time,
        ],
      );
    }
  }

  /** What of a sale can still be refunded. The register calls this before offering one. */
  async refundableLines(orgId: string, saleId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: saleRows } = await tx.query<{ status: string; receipt_no: string }>(
        `SELECT status, receipt_no FROM sales WHERE id = $1`,
        [saleId],
      );
      const sale = saleRows[0];
      if (!sale) throw ApiException.notFound('sale');
      if (sale.status === 'voided') {
        throw new ApiException('conflict', 'this sale was voided; there is nothing to refund');
      }

      const { rows } = await tx.query(
        `SELECT id AS sale_line_id, variant_id, description, sku_snapshot,
                quantity::text, quantity_refunded::text,
                (abs(quantity) - quantity_refunded)::text AS refundable,
                unit_price_minor::text, tax_minor::text, unit_cost::text
         FROM sale_lines WHERE sale_id = $1 ORDER BY line_no`,
        [saleId],
      );

      return {
        sale_id: saleId,
        receipt_no: sale.receipt_no,
        lines: rows,
        fully_refunded: rows.every((r) => Number.parseFloat(r.refundable as string) <= 0),
      };
    });
  }

  async list(orgId: string, filter: { storeId?: string | undefined; limit: number }) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, receipt_no, store_id, register_id, cashier_user_id, approved_by,
                original_sale_id, reason_code, total_minor::text, completed_at
         FROM refunds
         WHERE ($1::uuid IS NULL OR store_id = $1)
         ORDER BY completed_at DESC
         LIMIT $2`,
        [filter.storeId ?? null, filter.limit],
      );
      return { data: rows, next_cursor: null };
    });
  }
}
