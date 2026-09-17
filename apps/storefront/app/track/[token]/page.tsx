import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { OrderStatus, ShopTrackedOrder } from "@snappos/contracts";
import { CancelOrder } from "@/components/CancelOrder";
import { AgeBadge } from "@/components/ProductCard";
import { ShopApiError, shopFetch } from "@/lib/api";
import { dateTime, money } from "@/lib/format";
import { getShopInfo } from "@/lib/shop";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** The steps a pickup order goes through, in the words a customer uses. */
const STEPS: { status: OrderStatus; label: string }[] = [
  { status: "placed", label: "Received" },
  { status: "accepted", label: "Accepted" },
  { status: "ready", label: "Ready for pickup" },
  { status: "completed", label: "Picked up" },
];

function reached(order: ShopTrackedOrder, step: OrderStatus): boolean {
  const order_of: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed"];
  const at = order_of.indexOf(order.status);
  const target = order_of.indexOf(step);
  return at >= 0 && target >= 0 && at >= target;
}

export default async function TrackPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ placed?: string }>;
}) {
  const { token } = await params;
  const { placed } = await searchParams;

  let order: ShopTrackedOrder;
  try {
    order = await shopFetch<ShopTrackedOrder>(`/orders/track/${encodeURIComponent(token)}`, {
      withCart: false,
      withSession: false,
    });
  } catch (e) {
    if (e instanceof ShopApiError && e.status === 404) notFound();
    throw e;
  }
  const info = await getShopInfo();
  const stopped = order.status === "cancelled" || order.status === "rejected";
  const pickupAddress = [order.pickup.address_line1, [order.pickup.city, order.pickup.region].filter(Boolean).join(", "), order.pickup.postal_code]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      {placed ? (
        <div role="status" className="flex flex-col gap-1">
          <p className="display text-4xl font-extrabold uppercase">
            Thanks{order.first_name ? `, ${order.first_name}` : ""}.
          </p>
          <p className="text-[var(--muted)]">
            Your order is in. We&apos;ve emailed a copy of this page, and we&apos;ll email again when it&apos;s ready.
          </p>
        </div>
      ) : (
        <h1 className="display text-4xl font-extrabold uppercase">Your order</h1>
      )}

      {/* The pickup ticket: what to show at the counter. */}
      <article
        aria-labelledby="ticket-number"
        className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--surface)]"
      >
        <header className="flex flex-wrap items-end justify-between gap-4 p-6">
          <div>
            <p className="eyebrow">Order number</p>
            <p id="ticket-number" className="display tabular text-4xl font-extrabold sm:text-5xl">
              {order.order_number}
            </p>
          </div>
          <p
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
              stopped
                ? "bg-[var(--surface-sunk)] text-[var(--muted)]"
                : order.status === "ready"
                  ? "bg-[var(--ember)] text-[var(--ember-ink)]"
                  : "bg-[var(--surface-sunk)]"
            }`}
          >
            {order.status_label}
          </p>
        </header>

        {!stopped ? (
          <ol className="grid grid-cols-4 gap-1 px-6 pb-6" aria-label="Progress">
            {STEPS.map((step) => {
              const done = reached(order, step.status);
              return (
                <li key={step.status} className="flex flex-col gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 rounded-full ${done ? "bg-[var(--ember)]" : "bg-[var(--surface-sunk)]"}`}
                  />
                  <span className={`text-xs ${done ? "font-semibold" : "text-[var(--muted)]"}`}>
                    {step.label}
                    <span className="sr-only">{done ? ", done" : ", not yet"}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {stopped && order.resolution_note ? (
          <p className="mx-6 mb-6 rounded-xl bg-[var(--surface-sunk)] px-4 py-3 text-sm">{order.resolution_note}</p>
        ) : null}

        <hr className="perforation" />

        <div className="flex flex-col gap-5 p-6">
          <ul className="flex flex-col gap-2 text-sm">
            {order.lines.map((line, index) => (
              <li key={index} className={`flex justify-between gap-3 ${line.removed ? "text-[var(--muted)]" : ""}`}>
                <span>
                  <span className="tabular">{line.quantity} ×</span>{" "}
                  <span className={line.removed ? "line-through" : ""}>{line.description}</span>
                  {line.removed ? (
                    <span className="block text-xs">Couldn&apos;t be filled{line.removed_reason ? `: ${line.removed_reason}` : ""}</span>
                  ) : null}
                </span>
                <span className={`tabular ${line.removed ? "line-through" : ""}`}>{money(line.line_total_minor)}</span>
              </li>
            ))}
          </ul>

          <dl className="tabular flex flex-col gap-1 border-t border-[var(--line)] pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Subtotal</dt>
              <dd>{money(order.subtotal_minor)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Sales tax</dt>
              <dd>{money(order.tax_minor)}</dd>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <dt>{order.status === "completed" ? "Paid" : "To pay at pickup"}</dt>
              <dd>{money(order.total_minor)}</dd>
            </div>
          </dl>

          {!stopped && order.status !== "completed" ? (
            <div className="grid gap-4 rounded-2xl bg-[var(--surface-sunk)] p-4 text-sm sm:grid-cols-2">
              <div>
                <p className="eyebrow">Pick up at</p>
                <p className="mt-1 font-semibold">{order.pickup.store_name}</p>
                {pickupAddress ? <p className="text-[var(--muted)]">{pickupAddress}</p> : null}
                {order.pickup.phone ? (
                  <p className="mt-1">
                    <a href={`tel:${order.pickup.phone}`} className="underline underline-offset-2">
                      {order.pickup.phone}
                    </a>
                  </p>
                ) : null}
              </div>
              {order.minimum_age ? (
                <div className="flex items-start gap-2">
                  <AgeBadge age={order.minimum_age} />
                  <p>
                    Bring a valid photo ID. You must be {order.minimum_age} or older, and we can&apos;t hand the order
                    over without seeing it.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="text-xs text-[var(--muted)]">
            Placed {dateTime(order.placed_at, info?.store.timezone)}
            {order.completed_at ? ` · Picked up ${dateTime(order.completed_at, info?.store.timezone)}` : ""}
            {order.cancelled_at ? ` · Ended ${dateTime(order.cancelled_at, info?.store.timezone)}` : ""}
          </p>
        </div>
      </article>

      {order.can_cancel ? (
        <section aria-labelledby="change-heading" className="flex flex-col gap-2">
          <h2 id="change-heading" className="text-sm font-semibold">
            Changed your mind?
          </h2>
          <p className="text-sm text-[var(--muted)]">You can cancel until the shop starts on your order.</p>
          <CancelOrder token={token} />
        </section>
      ) : !stopped && order.status !== "completed" ? (
        <p className="text-sm text-[var(--muted)]">
          Need to change or cancel? The shop has started on your order, so{" "}
          {order.pickup.phone ? (
            <a href={`tel:${order.pickup.phone}`} className="underline underline-offset-2">
              call {order.pickup.phone}
            </a>
          ) : (
            "call the shop"
          )}
          .
        </p>
      ) : null}

      <Link href="/" className="text-sm underline underline-offset-2">
        Back to the shop
      </Link>
    </div>
  );
}
