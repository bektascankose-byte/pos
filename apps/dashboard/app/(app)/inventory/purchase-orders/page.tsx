import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { PurchaseOrder } from "@snappos/contracts";

export default async function PurchaseOrdersPage() {
  let orders: PurchaseOrder[] = [];
  let error: string | null = null;

  try {
    const storeId = await primaryStoreId();
    orders = storeId
      ? await apiFetch<PurchaseOrder[]>(`/api/v1/purchasing/purchase-orders?store_id=${storeId}`)
      : [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load purchase orders.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Purchase orders</h1>
        <Link
          href="/inventory/purchase-orders/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          New purchase order
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Reference</th>
              <th className="px-4 py-2 font-normal">Vendor</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Total</th>
              <th className="px-4 py-2 font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <tr key={po.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/inventory/purchase-orders/${po.id}`} className="text-[var(--color-accent)]">
                    {po.reference}
                  </Link>
                </td>
                <td className="px-4 py-2">{po.vendor_name}</td>
                <td className="px-4 py-2 capitalize">{po.status}</td>
                <td className="px-4 py-2 tabular-nums">{formatMinor(po.total_minor)}</td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(po.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {orders.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No purchase orders yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
