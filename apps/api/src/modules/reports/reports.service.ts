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
  MoneyFlow,
  VendorSpendRow,
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

  /**
   * Money out against money in, day by day.
   *
   * Two things are being compared that are not measured alike, and the query
   * is built to make that visible rather than to smooth it over:
   *
   * - Sales come from completed sales, with the cost of goods snapshotted on
   *   each line at the time of sale. That is the honest basis for margin --
   *   today's `average_cost` would restate what last month's margin was every
   *   time a vendor changes a price.
   * - Purchases come from uploaded vendor invoices, dated by the date the
   *   VENDOR put on them, not the day they were uploaded. An invoice typed in
   *   November for a September delivery is September's cost.
   *
   * A full calendar series is generated so a day with sales but no invoices
   * (the common case) still plots at zero instead of being skipped, which
   * would otherwise draw a line implying purchases happened between two
   * distant deliveries.
   *
   * Invoices with no date at all cannot be placed on any day; they are
   * counted separately rather than silently dropped or dumped on day one.
   */
  async moneyFlow(orgId: string, params: ReportRangeQuery): Promise<MoneyFlow> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        date: string;
        sales_minor: string;
        cogs_minor: string;
        purchases_minor: string;
      }>(
        `WITH days AS (
           SELECT generate_series(date_trunc('day', $2::timestamptz),
                                  date_trunc('day', $3::timestamptz - interval '1 microsecond'),
                                  interval '1 day')::date AS day
         ),
         sold AS (
           SELECT date_trunc('day', completed_at)::date AS day,
                  sum(total_minor) AS sales_minor,
                  -- cost_total is numeric(16,6) dollars; minor units for the
                  -- wire, rounded once at the end rather than per line.
                  round(sum(cost_total) * 100) AS cogs_minor
           FROM sales
           WHERE status = 'completed'
             AND completed_at >= $2 AND completed_at < $3
             AND ($1::uuid IS NULL OR store_id = $1)
           GROUP BY 1
         ),
         bought AS (
           SELECT invoice_date AS day, sum(invoice_total_minor) AS purchases_minor
           FROM invoice_imports
           WHERE invoice_date IS NOT NULL
             AND invoice_date >= date_trunc('day', $2::timestamptz)::date
             AND invoice_date <  date_trunc('day', $3::timestamptz)::date
             AND invoice_total_minor IS NOT NULL
             AND status <> 'failed'
             AND ($1::uuid IS NULL OR store_id = $1)
           GROUP BY 1
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
                COALESCE(s.sales_minor, 0)::text     AS sales_minor,
                COALESCE(s.cogs_minor, 0)::text      AS cogs_minor,
                COALESCE(b.purchases_minor, 0)::text AS purchases_minor
         FROM days d
         LEFT JOIN sold s   ON s.day = d.day
         LEFT JOIN bought b ON b.day = d.day
         ORDER BY d.day`,
        [params.store_id ?? null, params.from, params.to],
      );

      const { rows: undated } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoice_imports
         WHERE invoice_date IS NULL AND status <> 'failed'
           AND created_at >= $2 AND created_at < $3
           AND ($1::uuid IS NULL OR store_id = $1)`,
        [params.store_id ?? null, params.from, params.to],
      );

      const { rows: counted } = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoice_imports
         WHERE invoice_date IS NOT NULL
           AND invoice_date >= date_trunc('day', $2::timestamptz)::date
           AND invoice_date <  date_trunc('day', $3::timestamptz)::date
           AND invoice_total_minor IS NOT NULL AND status <> 'failed'
           AND ($1::uuid IS NULL OR store_id = $1)`,
        [params.store_id ?? null, params.from, params.to],
      );

      const points = rows.map((row) => ({
        date: row.date,
        sales_minor: row.sales_minor,
        cogs_minor: row.cogs_minor,
        purchases_minor: row.purchases_minor,
      }));

      // Summed as BigInt, never as floats: these are money.
      const total = (pick: (p: (typeof points)[number]) => string) =>
        points.reduce((sum, point) => sum + BigInt(pick(point)), 0n);

      const sales = total((p) => p.sales_minor);
      const cogs = total((p) => p.cogs_minor);
      const grossProfit = sales - cogs;

      return {
        points,
        summary: {
          sales_minor: sales.toString(),
          cogs_minor: cogs.toString(),
          gross_profit_minor: grossProfit.toString(),
          // Rounded to four places so a rate is comparable across ranges
          // without pretending to more precision than it has.
          margin_rate:
            sales > 0n ? Math.round((Number(grossProfit) / Number(sales)) * 10_000) / 10_000 : null,
          purchases_minor: total((p) => p.purchases_minor).toString(),
          invoice_count: Number(counted[0]?.n ?? '0'),
          undated_invoice_count: Number(undated[0]?.n ?? '0'),
        },
      };
    });
  }

  /**
   * Who the money went to, and what the paperwork still says is owed.
   *
   * Explicitly not accounts payable: `amount_paid_minor` is whatever the
   * vendor's own document claimed had been paid when it was extracted, so
   * "outstanding" here means "this invoice said so", not "the bank agrees".
   * Payments made after the invoice was issued are invisible to it.
   *
   * Outstanding is floored at zero -- an invoice showing an overpayment is a
   * credit on account, and letting it subtract from what other invoices owe
   * would understate the real exposure.
   */
  async vendorSpend(orgId: string, params: ReportRangeQuery): Promise<VendorSpendRow[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        vendor_id: string | null;
        vendor_name: string | null;
        invoice_count: string;
        invoiced_minor: string;
        paid_minor: string;
        outstanding_minor: string;
        last_invoice_date: string | null;
      }>(
        `SELECT ii.vendor_id,
                v.name AS vendor_name,
                count(*)::text AS invoice_count,
                COALESCE(sum(ii.invoice_total_minor), 0)::text AS invoiced_minor,
                COALESCE(sum(ii.amount_paid_minor), 0)::text AS paid_minor,
                COALESCE(sum(GREATEST(ii.invoice_total_minor - COALESCE(ii.amount_paid_minor, 0), 0)), 0)::text
                  AS outstanding_minor,
                to_char(max(ii.invoice_date), 'YYYY-MM-DD') AS last_invoice_date
         FROM invoice_imports ii
         LEFT JOIN vendors v ON v.id = ii.vendor_id
         WHERE ii.status <> 'failed'
           AND ii.invoice_total_minor IS NOT NULL
           AND ii.invoice_date >= date_trunc('day', $2::timestamptz)::date
           AND ii.invoice_date <  date_trunc('day', $3::timestamptz)::date
           AND ($1::uuid IS NULL OR ii.store_id = $1)
         GROUP BY ii.vendor_id, v.name
         ORDER BY sum(ii.invoice_total_minor) DESC`,
        [params.store_id ?? null, params.from, params.to],
      );

      return rows.map((row) => ({
        vendor_id: row.vendor_id,
        vendor_name: row.vendor_name,
        invoice_count: Number(row.invoice_count),
        invoiced_minor: row.invoiced_minor,
        paid_minor: row.paid_minor,
        outstanding_minor: row.outstanding_minor,
        last_invoice_date: row.last_invoice_date,
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
