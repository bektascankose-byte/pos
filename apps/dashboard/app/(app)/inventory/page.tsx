import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { StockLevelRow } from "@snappos/contracts";

export default async function InventoryPage() {
  let rows: StockLevelRow[] = [];
  let error: string | null = null;

  try {
    const storeId = await primaryStoreId();
    rows = storeId
      ? await apiFetch<StockLevelRow[]>(`/api/v1/inventory/stock?store_id=${storeId}`)
      : [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load stock levels.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <Link
          href="/inventory/purchase-orders"
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
        >
          Purchase orders
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">SKU</th>
              <th className="px-4 py-2 font-normal">On hand</th>
              <th className="px-4 py-2 font-normal">Reserved</th>
              <th className="px-4 py-2 font-normal">Available</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.variant_id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/inventory/${row.variant_id}`} className="text-[var(--color-accent)]">
                    {row.product_name}
                    {row.variant_name ? ` — ${row.variant_name}` : ""}
                  </Link>
                </td>
                <td className="px-4 py-2">{row.sku}</td>
                <td className="px-4 py-2 tabular-nums">{row.on_hand}</td>
                <td className="px-4 py-2 tabular-nums">{row.reserved}</td>
                <td className="px-4 py-2 tabular-nums">{row.available}</td>
              </tr>
            ))}
            {rows.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No active products yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
