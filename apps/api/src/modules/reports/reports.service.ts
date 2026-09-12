import { Injectable } from '@nestjs/common';
import type { SalesSummaryQuery, SalesSummary } from '@snappos/contracts';
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
}
