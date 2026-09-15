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
  AttentionItem,
  AttentionGroup,
  NeedsAttention,
  OpenInvoiceRow,
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

  /**
   * Everything waiting on a person, in one read.
   *
   * Each group runs as a single query that returns both its first few rows and
   * a `count(*) OVER ()` total, so a dashboard showing "12 items, here are 5"
   * doesn't cost two round trips per signal. No rows means a total of zero,
   * which is the answer either way.
   *
   * The price lookup repeated below is the same one the register and the
   * catalog use: a store's own price wins over the org default, and a price
   * that hasn't started or has already ended doesn't count.
   */
  async needsAttention(orgId: string, storeId: string | null): Promise<NeedsAttention> {
    const CURRENT_PRICE = `
      SELECT price_minor FROM variant_prices
      WHERE variant_id = v.id
        AND (store_id = $1 OR store_id IS NULL)
        AND kind = 'regular'
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      ORDER BY store_id NULLS LAST, effective_from DESC
      LIMIT 1`;

    const SELECT_ITEM = `
      v.id AS variant_id, p.id AS product_id, p.name AS product_name,
      v.variant_name, v.sku, count(*) OVER ()::int AS total`;

    return this.db.withOrg(orgId, async (tx) => {
      const group = (rows: (AttentionItem & { total: number })[]): AttentionGroup => ({
        count: rows[0]?.total ?? 0,
        items: rows.map(({ total: _total, ...item }) => item),
      });

      const [unpriced, belowCost, lowStock, negativeStock, deadStock, invoices] = await Promise.all([
        // Can't be sold at all: the register refuses an item with no price.
        tx.query<AttentionItem & { total: number }>(
          `SELECT ${SELECT_ITEM},
                  NULL::text AS price_minor, v.cost::text,
                  NULL::text AS on_hand, NULL::text AS reorder_point,
                  NULL::timestamptz AS last_sold_at
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           LEFT JOIN LATERAL (${CURRENT_PRICE}) pr ON true
           WHERE v.status = 'active' AND p.status = 'active' AND pr.price_minor IS NULL
           ORDER BY p.name, v.sort_order
           LIMIT 5`,
          [storeId],
        ),

        // Losing money on every sale. Zero cost means nobody has said what it
        // cost yet, which is a different problem from selling under cost.
        tx.query<AttentionItem & { total: number }>(
          `SELECT ${SELECT_ITEM},
                  pr.price_minor::text, v.cost::text,
                  NULL::text AS on_hand, NULL::text AS reorder_point,
                  NULL::timestamptz AS last_sold_at
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN LATERAL (${CURRENT_PRICE}) pr ON true
           WHERE v.status = 'active' AND p.status = 'active'
             AND v.cost > 0
             AND pr.price_minor < v.cost * 100
           ORDER BY (v.cost * 100 - pr.price_minor) DESC
           LIMIT 5`,
          [storeId],
        ),

        // About to run out, by the shop's own reorder point.
        tx.query<AttentionItem & { total: number }>(
          `SELECT ${SELECT_ITEM},
                  NULL::text AS price_minor, NULL::text AS cost,
                  il.available::text AS on_hand, v.reorder_point::text,
                  NULL::timestamptz AS last_sold_at
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN inventory_levels il ON il.variant_id = v.id AND il.store_id = $1
           WHERE v.status = 'active' AND p.status = 'active'
             AND v.reorder_point IS NOT NULL
             AND il.available < v.reorder_point
           ORDER BY (il.available - v.reorder_point)
           LIMIT 5`,
          [storeId],
        ),

        // Below zero, which no shelf ever is: a count is wrong somewhere, and
        // everything derived from it -- valuation, reordering -- is wrong too.
        tx.query<AttentionItem & { total: number }>(
          `SELECT ${SELECT_ITEM},
                  NULL::text AS price_minor, NULL::text AS cost,
                  il.on_hand::text, v.reorder_point::text,
                  NULL::timestamptz AS last_sold_at
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN inventory_levels il ON il.variant_id = v.id AND il.store_id = $1
           WHERE v.status = 'active' AND p.status = 'active'
             AND il.on_hand < 0
           ORDER BY il.on_hand
           LIMIT 5`,
          [storeId],
        ),

        // Money sitting on a shelf: stock on hand that hasn't sold in 60 days.
        tx.query<AttentionItem & { total: number }>(
          `SELECT ${SELECT_ITEM},
                  NULL::text AS price_minor, NULL::text AS cost,
                  il.on_hand::text,
                  NULL::text AS reorder_point,
                  (SELECT max(l.occurred_at) FROM inventory_ledger l
                    WHERE l.variant_id = v.id AND l.reason = 'sale') AS last_sold_at
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN inventory_levels il ON il.variant_id = v.id AND il.store_id = $1
           WHERE v.status = 'active' AND p.status = 'active'
             AND il.on_hand > 0
             AND NOT EXISTS (
               SELECT 1 FROM inventory_ledger l
               WHERE l.variant_id = v.id AND l.reason = 'sale'
                 AND l.occurred_at > now() - interval '60 days'
             )
           ORDER BY il.on_hand DESC
           LIMIT 5`,
          [storeId],
        ),

        // Parsed but never committed: stock the shop believes it has and doesn't.
        tx.query<OpenInvoiceRow & { total: number }>(
          `SELECT id, source_filename, status::text, created_at, count(*) OVER ()::int AS total
           FROM invoice_imports
           WHERE status IN ('parsed', 'reviewed')
             AND ($1::uuid IS NULL OR store_id = $1)
           ORDER BY created_at DESC
           LIMIT 5`,
          [storeId],
        ),
      ]);

      return {
        unpriced: group(unpriced.rows),
        below_cost: group(belowCost.rows),
        low_stock: group(lowStock.rows),
        negative_stock: group(negativeStock.rows),
        dead_stock: group(deadStock.rows),
        open_invoices: {
          count: invoices.rows[0]?.total ?? 0,
          items: invoices.rows.map(({ total: _total, ...row }) => row),
        },
      };
    });
  }
}
