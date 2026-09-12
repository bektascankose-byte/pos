import { Injectable } from '@nestjs/common';
import type {
  SalesSummaryQuery,
  SalesSummary,
  ReportRangeQuery,
  SalesTrendPoint,
  TopProductsQuery,
  TopProductRow,
  ByCashierRow,
  ByPaymentMethodRow,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Totals for the "how did we do" question, answered in one query rather
   * than by pulling every sale over HTTP and summing them client side.
   *
   * Voided sales are excluded -- a void means the sale did not happen, and a
   * dashboard that counts it toward the day's total is telling an owner
   * something untrue about their own shop.
   */
  async salesSummary(orgId: string, params: SalesSummaryQuery): Promise<SalesSummary> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        sale_count: string;
        gross_minor: string;
        tax_minor: string;
      }>(
        `SELECT count(*)::text AS sale_count,
                COALESCE(sum(total_minor), 0)::text AS gross_minor,
                COALESCE(sum(tax_minor), 0)::text AS tax_minor
         FROM sales
         WHERE status = 'completed'
           AND ($1::uuid IS NULL OR store_id = $1)
           AND ($2::timestamptz IS NULL OR completed_at >= $2)
           AND ($3::timestamptz IS NULL OR completed_at < $3)`,
        [params.store_id ?? null, params.from ?? null, params.to ?? null],
      );

      const row = rows[0]!;
      const count = Number(row.sale_count);
      const gross = BigInt(row.gross_minor);
      const average = count > 0 ? gross / BigInt(count) : 0n;

      return {
        sale_count: count,
        gross_minor: row.gross_minor,
        tax_minor: row.tax_minor,
        average_ticket_minor: average.toString(),
      };
    });
  }

  /** One point per calendar day in range, so a flat chart doesn't hide a bad week inside a good month. */
  async salesTrend(orgId: string, params: ReportRangeQuery): Promise<SalesTrendPoint[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ date: string; sale_count: string; gross_minor: string }>(
        `SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS date,
                count(*)::text AS sale_count,
                COALESCE(sum(total_minor), 0)::text AS gross_minor
         FROM sales
         WHERE status = 'completed'
           AND completed_at >= $2
           AND completed_at < $3
           AND ($1::uuid IS NULL OR store_id = $1)
         GROUP BY 1
         ORDER BY 1`,
        [params.store_id ?? null, params.from, params.to],
      );

      return rows.map((row) => ({
        date: row.date,
        sale_count: Number(row.sale_count),
        gross_minor: row.gross_minor,
      }));
    });
  }

  /** What's actually moving -- ranked by revenue, not unit count, so a $1 item selling 500 units doesn't outrank the case that pays the rent. */
  async topProducts(orgId: string, params: TopProductsQuery): Promise<TopProductRow[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        product_id: string;
        product_name: string;
        category_name: string | null;
        quantity: string;
        gross_minor: string;
      }>(
        `SELECT p.id AS product_id,
                p.name AS product_name,
                c.name AS category_name,
                sum(sl.quantity)::text AS quantity,
                COALESCE(sum(sl.total_minor), 0)::text AS gross_minor
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN product_variants pv ON pv.id = sl.variant_id
         JOIN products p ON p.id = pv.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE s.status = 'completed'
           AND s.completed_at >= $2
           AND s.completed_at < $3
           AND ($1::uuid IS NULL OR s.store_id = $1)
         GROUP BY p.id, p.name, c.name
         ORDER BY sum(sl.total_minor) DESC
         LIMIT $4`,
        [params.store_id ?? null, params.from, params.to, params.limit],
      );

      return rows;
    });
  }

  /** Who rang up what -- useful for accountability and scheduling, not a performance-review tool by itself. */
  async byCashier(orgId: string, params: ReportRangeQuery): Promise<ByCashierRow[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        cashier_user_id: string;
        cashier_name: string;
        sale_count: string;
        gross_minor: string;
      }>(
        `SELECT s.cashier_user_id,
                u.full_name AS cashier_name,
                count(*)::text AS sale_count,
                COALESCE(sum(s.total_minor), 0)::text AS gross_minor
         FROM sales s
         JOIN users u ON u.id = s.cashier_user_id
         WHERE s.status = 'completed'
           AND s.completed_at >= $2
           AND s.completed_at < $3
           AND ($1::uuid IS NULL OR s.store_id = $1)
         GROUP BY s.cashier_user_id, u.full_name
         ORDER BY sum(s.total_minor) DESC`,
        [params.store_id ?? null, params.from, params.to],
      );

      return rows.map((row) => ({
        cashier_user_id: row.cashier_user_id,
        cashier_name: row.cashier_name,
        sale_count: Number(row.sale_count),
        gross_minor: row.gross_minor,
      }));
    });
  }

  /**
   * Cash vs. card vs. everything else, for till reconciliation. Scoped to
   * payments that actually tendered against a sale (`sale_id IS NOT NULL`,
   * `status = 'captured'`) -- a refund's tender is the opposite question, and
   * a pending or failed payment never happened.
   */
  async byPaymentMethod(orgId: string, params: ReportRangeQuery): Promise<ByPaymentMethodRow[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        method: string;
        payment_count: string;
        amount_minor: string;
      }>(
        `SELECT pay.method,
                count(*)::text AS payment_count,
                COALESCE(sum(pay.amount_minor), 0)::text AS amount_minor
         FROM payments pay
         JOIN sales s ON s.id = pay.sale_id
         WHERE pay.sale_id IS NOT NULL
           AND pay.status = 'captured'
           AND s.status = 'completed'
           AND s.completed_at >= $2
           AND s.completed_at < $3
           AND ($1::uuid IS NULL OR s.store_id = $1)
         GROUP BY pay.method
         ORDER BY sum(pay.amount_minor) DESC`,
        [params.store_id ?? null, params.from, params.to],
      );

      return rows.map((row) => ({
        method: row.method as ByPaymentMethodRow['method'],
        payment_count: Number(row.payment_count),
        amount_minor: row.amount_minor,
      }));
    });
  }
}
