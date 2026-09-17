import type { PoolClient } from 'pg';
import type { ApplicableRate, OrderFulfilment } from '@snappos/contracts';

/**
 * The sales tax rates in force for a store and channel, grouped by tax category.
 *
 * Ad valorem rates only, applied as one combined rate per line -- which is how
 * the register charges tax today. A per-unit or compounding rate in the table
 * is not something either side models yet.
 *
 * Shared by the cart, which shows an estimate, and the order, which charges it,
 * so the number a shopper sees before checkout and the number collected at the
 * counter come from one query.
 */
export async function taxRatesByCategory(
  tx: PoolClient,
  storeId: string,
  fulfilment: OrderFulfilment,
): Promise<Map<string, ApplicableRate[]>> {
  const { rows } = await tx.query<{ tax_category_id: string; name: string; rate: string }>(
    `SELECT tax_category_id, name, rate::text AS rate
     FROM tax_rates
     WHERE (store_id = $1 OR store_id IS NULL)
       AND (channel IS NULL OR channel = $2::compliance_channel)
       AND effective_from <= now()
       AND (effective_to IS NULL OR effective_to > now())
     ORDER BY apply_order, name`,
    [storeId, fulfilment === 'pickup' ? 'pickup' : 'delivery'],
  );
  const byCategory = new Map<string, ApplicableRate[]>();
  for (const row of rows) {
    const list = byCategory.get(row.tax_category_id) ?? [];
    list.push({ name: row.name, rate: row.rate });
    byCategory.set(row.tax_category_id, list);
  }
  return byCategory;
}
