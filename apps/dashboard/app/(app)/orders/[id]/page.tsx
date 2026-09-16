import Link from "next/link";
import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { isTerminal, readableStatus, type Order } from "@snappos/contracts";
import { OrderActions } from "../OrderActions";
import { RemoveLineButton } from "./RemoveLineButton";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let order: Order;
  try {
    order = await apiFetch<Order>(`/api/v1/orders/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const live = order.lines.filter((line) => !line.removed_at);
  const removed = order.lines.filter((line) => line.removed_at);
  const contact = order.customer_name ?? order.guest_name ?? "Guest";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/orders" className="text-sm text-[var(--color-accent)]">
            ← Online orders
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{order.order_number}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {contact} · <span className="capitalize">{order.fulfilment}</span> ·{" "}
            <span className="capitalize">{readableStatus(order.status)}</span>
          </p>
        </div>
        <OrderActions id={order.id} status={order.status} />
      </div>

      {order.resolution_note ? (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
          <span className="text-[var(--color-text-muted)]">Told the customer:</span>{" "}
          {order.resolution_note}
        </p>
      ) : null}

      {order.note ? (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
          <span className="text-[var(--color-text-muted)]">From the customer:</span> {order.note}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Items</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Item</th>
                <th className="px-4 py-2 font-normal">UPC</th>
                <th className="px-4 py-2 text-right font-normal">Qty</th>
                <th className="px-4 py-2 text-right font-normal">Each</th>
                <th className="px-4 py-2 text-right font-normal">Total</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {live.map((line) => (
                <tr key={line.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">{line.description}</td>
                  <td className="px-4 py-2 font-mono text-xs">{line.upc_snapshot}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{trimQuantity(line.quantity)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMinor(line.unit_price_minor)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMinor(line.line_total_minor)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canEditLines(order.status) ? (
                      <RemoveLineButton orderId={order.id} lineId={line.id} label={line.description} />
                    ) : null}
                  </td>
                </tr>
              ))}

              {/* Kept visible rather than filtered away: a customer who ordered
                  four and collected three should be able to see that happened,
                  and so should whoever answers the phone about it. */}
              {removed.map((line) => (
                <tr
                  key={line.id}
                  className="border-t border-[var(--color-border)] text-[var(--color-text-muted)]"
                >
                  <td className="px-4 py-2 line-through">{line.description}</td>
                  <td className="px-4 py-2 font-mono text-xs line-through">{line.upc_snapshot}</td>
                  <td className="px-4 py-2 text-right tabular-nums line-through">
                    {trimQuantity(line.quantity)}
                  </td>
                  <td className="px-4 py-2" colSpan={2}>
                    Couldn&apos;t be filled — {line.removed_reason}
                  </td>
                  <td className="px-4 py-2" />
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-[var(--color-border)]">
              <tr>
                <td className="px-4 py-2 text-right text-[var(--color-text-muted)]" colSpan={4}>
                  Total
                </td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">
                  {formatMinor(order.total_minor)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {order.sale_id ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Handed over. This is now sale {order.sale_id.slice(0, 8)} and appears in Reports like any
            counter sale.
          </p>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">
            Nothing here has left the shelf yet. Stock moves when you hand it over.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">History</h2>
        <ol className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          {order.events.map((event, index) => (
            <li key={index} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[var(--color-text-muted)] tabular-nums">
                {new Date(event.created_at).toLocaleString()}
              </span>
              <span className="capitalize">{readableStatus(event.to_status)}</span>
              <span className="text-xs text-[var(--color-text-muted)]">by {event.actor_type}</span>
              {event.reason ? <span className="text-[var(--color-text-muted)]">— {event.reason}</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Contact</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          <dt className="text-[var(--color-text-muted)]">Name</dt>
          <dd>{contact}</dd>
          {order.guest_email ? (
            <>
              <dt className="text-[var(--color-text-muted)]">Email</dt>
              <dd>{order.guest_email}</dd>
            </>
          ) : null}
          {order.guest_phone ? (
            <>
              <dt className="text-[var(--color-text-muted)]">Phone</dt>
              <dd>{order.guest_phone}</dd>
            </>
          ) : null}
          {order.pickup_from ? (
            <>
              <dt className="text-[var(--color-text-muted)]">Asked to collect</dt>
              <dd>{new Date(order.pickup_from).toLocaleString()}</dd>
            </>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

/**
 * A line can come off until the order is finished — including at the counter,
 * when the bag turns out to be short. The same rule the API applies, asked of
 * the same state machine.
 */
function canEditLines(status: Order["status"]): boolean {
  return !isTerminal(status);
}

/** "2.000" reads as a weight. Quantities here are usually whole units. */
function trimQuantity(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
