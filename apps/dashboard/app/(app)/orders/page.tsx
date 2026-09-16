import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { formatMinor } from "@/lib/money";
import { readableStatus, type OrderQueueEntry } from "@snappos/contracts";
import { OrderActions } from "./OrderActions";

/**
 * The counter's queue.
 *
 * Oldest first, and never paged: a queue that needs a second page is a queue
 * that has already gone wrong, and burying the oldest order behind a "next" is
 * exactly how it stays wrong. Only live orders appear — finished ones are
 * sales, and belong in Reports with every other sale.
 */
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  let orders: OrderQueueEntry[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    if (!storeId) throw new Error("no store");
    orders = await apiFetch<OrderQueueEntry[]>(`/api/v1/orders?store_id=${storeId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load the order queue.";
  }

  const waitingLongest = orders[0]?.waiting_seconds ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Online orders</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          What customers have ordered and not yet collected. Nothing here has left the shelf — stock
          moves when you hand it over.
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      {!error && orders.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
          No orders waiting.
        </p>
      ) : null}

      {orders.length > 0 ? (
        <>
          {waitingLongest >= 900 ? (
            <p className="rounded-md border border-[var(--color-warning,var(--color-border))] bg-[var(--color-surface)] px-3 py-2 text-sm">
              The oldest order has been waiting {describeWait(waitingLongest)}.
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-4 py-2 font-normal">Order</th>
                  <th className="px-4 py-2 font-normal">Customer</th>
                  <th className="px-4 py-2 font-normal">For</th>
                  <th className="px-4 py-2 text-right font-normal">Items</th>
                  <th className="px-4 py-2 text-right font-normal">Total</th>
                  <th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal">Waiting</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-t border-[var(--color-border)] align-middle">
                    <td className="px-4 py-2">
                      <Link href={`/orders/${order.id}`} className="text-[var(--color-accent)]">
                        {order.order_number}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{order.customer_name ?? "Guest"}</td>
                    <td className="px-4 py-2 capitalize">{order.fulfilment}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{order.line_count}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMinor(order.total_minor)}</td>
                    <td className="px-4 py-2 capitalize">{readableStatus(order.status)}</td>
                    <td
                      className="px-4 py-2 tabular-nums"
                      title={new Date(order.placed_at).toLocaleString()}
                    >
                      {describeWait(order.waiting_seconds)}
                    </td>
                    <td className="px-4 py-2">
                      <OrderActions id={order.id} status={order.status} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** "4 min", not "00:04:12". Nobody reads a stopwatch across a counter. */
function describeWait(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
