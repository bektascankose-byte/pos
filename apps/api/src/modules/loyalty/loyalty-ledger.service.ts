import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  pointsForBasis,
  pointsValueMinor,
  type CustomerLoyalty,
  type LoyaltyEntry,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

/**
 * What counts toward points on a sale line: what was paid for it before tax,
 * on lines that are goods (not a delivery fee) and are not in a class the
 * program excludes. One SQL expression, used for sales and refunds alike, so
 * a refund can never take back points on a different basis than the sale
 * earned them on.
 */
const ELIGIBLE_LINE = `p.track_inventory
  AND NOT (COALESCE(pc.regulated_class, '') = ANY(ls.excluded_regulated_classes))`;

/**
 * The loyalty ledger: points earned, taken back and corrected.
 *
 * Every method that changes points runs inside a transaction the caller owns --
 * the sale intake, the void, the refund -- so points can never be earned by a
 * sale that then fails to commit, or survive a void that did.
 */
@Injectable()
export class LoyaltyLedger {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Earn points for a completed sale.
   *
   * Nothing for a sale with no customer, a program that is switched off, or a
   * customer whose record was anonymized. A replayed sale earns nothing a
   * second time: the unique index on the sale's earn entry refuses it.
   */
  async earnForSaleTx(tx: PoolClient, saleId: string): Promise<number> {
    const { rows } = await tx.query<{
      customer_id: string | null;
      status: string;
      active: boolean | null;
      rate: string | null;
      anonymized: boolean;
      basis: string;
    }>(
      `SELECT s.customer_id, s.status::text, ls.is_active AS active, ls.earn_points_per_dollar::text AS rate,
              (c.anonymized_at IS NOT NULL OR c.status <> 'active') AS anonymized,
              COALESCE(sum(sl.total_minor - sl.tax_minor) FILTER (WHERE ${ELIGIBLE_LINE}), 0)::text AS basis
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN loyalty_settings ls ON ls.org_id = s.org_id
       JOIN sale_lines sl ON sl.sale_id = s.id
       JOIN product_variants v ON v.id = sl.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_compliance pc ON pc.product_id = p.id
       WHERE s.id = $1
       GROUP BY s.customer_id, s.status, ls.is_active, ls.earn_points_per_dollar, c.anonymized_at, c.status`,
      [saleId],
    );
    const sale = rows[0];
    if (!sale?.customer_id || sale.status !== 'completed' || !sale.active || !sale.rate || sale.anonymized) return 0;

    const points = pointsForBasis(BigInt(sale.basis), sale.rate);
    if (points <= 0) return 0;

    const { rowCount } = await tx.query(
      `INSERT INTO loyalty_ledger (org_id, customer_id, kind, points, sale_id, basis_minor, rate)
       VALUES (current_setting('app.org_id')::uuid, $1, 'earn', $2, $3, $4, $5::numeric)
       ON CONFLICT (sale_id) WHERE kind = 'earn' DO NOTHING`,
      [sale.customer_id, points, saleId, sale.basis, sale.rate],
    );
    return rowCount ? points : 0;
  }

  /** Take back whatever a voided sale earned that a refund has not already taken back. */
  async reverseForVoidTx(tx: PoolClient, saleId: string, actorUserId: string | null, reason: string): Promise<number> {
    const outstanding = await this.outstandingTx(tx, saleId);
    if (!outstanding || outstanding.points <= 0) return 0;

    const { rowCount } = await tx.query(
      `INSERT INTO loyalty_ledger (org_id, customer_id, kind, points, sale_id, note, created_by)
       VALUES (current_setting('app.org_id')::uuid, $1, 'reverse', $2, $3, $4, $5)
       ON CONFLICT (sale_id) WHERE kind = 'reverse' AND refund_id IS NULL DO NOTHING`,
      [outstanding.customerId, -outstanding.points, saleId, `Sale voided: ${reason}`, actorUserId],
    );
    return rowCount ? outstanding.points : 0;
  }

  /**
   * Take back the points a refund returns: the refunded goods' share, worked
   * out at the rate the sale earned at, and never more than is still left
   * from that sale.
   */
  async reverseForRefundTx(tx: PoolClient, refundId: string): Promise<number> {
    const { rows } = await tx.query<{ sale_id: string | null; basis: string }>(
      `SELECT r.original_sale_id AS sale_id,
              COALESCE(sum(abs(rl.total_minor) - abs(rl.tax_minor)) FILTER (WHERE ${ELIGIBLE_LINE}), 0)::text AS basis
       FROM refunds r
       JOIN refund_lines rl ON rl.refund_id = r.id
       JOIN product_variants v ON v.id = rl.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_compliance pc ON pc.product_id = p.id
       LEFT JOIN loyalty_settings ls ON ls.org_id = r.org_id
       WHERE r.id = $1
       GROUP BY r.original_sale_id`,
      [refundId],
    );
    const refund = rows[0];
    if (!refund?.sale_id) return 0;

    const outstanding = await this.outstandingTx(tx, refund.sale_id);
    if (!outstanding || outstanding.points <= 0) return 0;

    const points = Math.min(pointsForBasis(BigInt(refund.basis), outstanding.rate), outstanding.points);
    if (points <= 0) return 0;

    const { rowCount } = await tx.query(
      `INSERT INTO loyalty_ledger (org_id, customer_id, kind, points, sale_id, refund_id, basis_minor, rate)
       VALUES (current_setting('app.org_id')::uuid, $1, 'reverse', $2, $3, $4, $5, $6::numeric)
       ON CONFLICT (refund_id) WHERE kind = 'reverse' AND refund_id IS NOT NULL DO NOTHING`,
      [outstanding.customerId, -points, refund.sale_id, refundId, refund.basis, outstanding.rate],
    );
    return rowCount ? points : 0;
  }

  /** A customer's balance, lifetime earnings and recent history, for the back office. */
  async customerLoyalty(orgId: string, customerId: string): Promise<CustomerLoyalty> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: customers } = await tx.query<{ has_online_account: boolean; phone_verified: boolean }>(
        `SELECT (cc.customer_id IS NOT NULL) AS has_online_account,
                (cc.verified_phone IS NOT NULL AND cc.verified_phone = c.phone) AS phone_verified
         FROM customers c LEFT JOIN customer_credentials cc ON cc.customer_id = c.id
         WHERE c.id = $1`,
        [customerId],
      );
      if (!customers[0]) throw ApiException.notFound('customer');

      const settings = await this.settingsTx(tx);
      const balance = await this.balanceTx(tx, customerId);
      return {
        program_name: settings.name,
        program_active: settings.is_active,
        points: balance.points,
        lifetime_earned: balance.lifetimeEarned,
        value_minor: pointsValueMinor(balance.points, settings.redemption_rate).toString(),
        has_online_account: customers[0].has_online_account,
        phone_verified: customers[0].phone_verified === true,
        entries: await this.entriesTx(tx, customerId, 100),
      };
    });
  }

  /** A person correcting a balance, with a reason the customer's history shows. */
  async adjust(orgId: string, actorUserId: string, customerId: string, points: number, note: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE id = $1 AND anonymized_at IS NULL`,
        [customerId],
      );
      if (!rows[0]) throw ApiException.notFound('customer');

      await tx.query(
        `INSERT INTO loyalty_ledger (org_id, customer_id, kind, points, note, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, 'adjust', $2, $3, $4)`,
        [customerId, points, note, actorUserId],
      );
      await this.audit.record(tx, {
        action: 'loyalty.adjust',
        entityType: 'customer',
        entityId: customerId,
        actorUserId,
        newValue: { points },
        reason: note,
      });
      return this.balanceTx(tx, customerId);
    });
  }

  async balanceTx(tx: PoolClient, customerId: string): Promise<{ points: number; lifetimeEarned: number }> {
    const { rows } = await tx.query<{ points: number | null; lifetime_earned: number | null }>(
      `SELECT points, lifetime_earned FROM loyalty_balances WHERE customer_id = $1`,
      [customerId],
    );
    return { points: rows[0]?.points ?? 0, lifetimeEarned: rows[0]?.lifetime_earned ?? 0 };
  }

  async entriesTx(tx: PoolClient, customerId: string, limit: number): Promise<LoyaltyEntry[]> {
    const { rows } = await tx.query<LoyaltyEntry>(
      `SELECT l.id, l.kind, l.points, l.sale_id, l.refund_id, s.receipt_no, s.channel::text AS channel,
              l.basis_minor::text AS basis_minor, l.note, l.occurred_at
       FROM loyalty_ledger l
       LEFT JOIN sales s ON s.id = l.sale_id
       WHERE l.customer_id = $1
       ORDER BY l.occurred_at DESC, l.id DESC
       LIMIT $2`,
      [customerId, limit],
    );
    return rows;
  }

  /** The program's name, switch and rates, with the defaults a shop that never saved them has. */
  async settingsTx(
    tx: PoolClient,
  ): Promise<{ name: string; is_active: boolean; earn_rate: string; redemption_rate: string }> {
    const { rows } = await tx.query<{ name: string; is_active: boolean; earn_rate: string; redemption_rate: string }>(
      `SELECT name, is_active, earn_points_per_dollar::text AS earn_rate,
              redemption_points_per_dollar::text AS redemption_rate
       FROM loyalty_settings WHERE org_id = current_setting('app.org_id')::uuid`,
    );
    return rows[0] ?? { name: 'Loyalty Rewards', is_active: false, earn_rate: '1', redemption_rate: '100' };
  }

  /** What a sale earned, less what has already been taken back, and whose it is now. */
  private async outstandingTx(
    tx: PoolClient,
    saleId: string,
  ): Promise<{ customerId: string; points: number; rate: string } | null> {
    const { rows } = await tx.query<{ customer_id: string; earned: number; rate: string; reversed: string }>(
      `SELECT e.customer_id, e.points AS earned, e.rate::text AS rate,
              COALESCE((SELECT sum(-r.points) FROM loyalty_ledger r
                         WHERE r.sale_id = e.sale_id AND r.kind = 'reverse'), 0)::text AS reversed
       FROM loyalty_ledger e
       WHERE e.sale_id = $1 AND e.kind = 'earn'`,
      [saleId],
    );
    const earn = rows[0];
    if (!earn) return null;
    return { customerId: earn.customer_id, points: earn.earned - Number(earn.reversed), rate: earn.rate };
  }
}
