"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMinor } from "@/lib/money";
import { receivePurchaseOrderAction } from "../actions";
import type { PurchaseOrder } from "@snappos/contracts";

const UNRECEIVABLE_STATUSES = new Set(["closed", "cancelled"]);

export function PurchaseOrderClient({ poId, initialPo }: { poId: string; initialPo: PurchaseOrder }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const po = initialPo;
  const lines = po.lines ?? [];
  const canReceive = !UNRECEIVABLE_STATUSES.has(po.status);
  const lineIds = lines.map((l) => l.id);

  const handleReceive = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await receivePurchaseOrderAction(poId, lineIds, formData);
      if (result.ok) {
        setMessage({ kind: "success", text: "Saved." });
        router.refresh();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{po.reference}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {po.vendor_name} · <span className="capitalize">{po.status}</span>
        </p>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total" value={formatMinor(po.total_minor)} />
        <SummaryCard label="Expected" value={po.expected_at ?? "—"} />
        <SummaryCard label="Created" value={new Date(po.created_at).toLocaleDateString()} />
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">Lines</div>
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Product</th>
              <th className="px-4 py-2 font-normal">Ordered</th>
              <th className="px-4 py-2 font-normal">Received</th>
              <th className="px-4 py-2 font-normal">Unit cost</th>
              <th className="px-4 py-2 font-normal">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  {line.product_name}
                  {line.variant_name ? ` — ${line.variant_name}` : ""}
                  <span className="block text-xs text-[var(--color-text-muted)]">{line.sku}</span>
                </td>
                <td className="px-4 py-2 tabular-nums">{line.quantity_ordered}</td>
                <td className="px-4 py-2 tabular-nums">{line.quantity_received}</td>
                <td className="px-4 py-2 tabular-nums">{line.unit_cost}</td>
                <td className="px-4 py-2 tabular-nums">{formatMinor(line.line_total_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {canReceive ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="mb-1 text-sm font-medium text-[var(--color-text-muted)]">Receive shipment</h2>
          <p className="mb-3 text-xs text-[var(--color-text-muted)]">
            Enter the quantity that actually arrived for each line. Leave a line blank to skip it --
            partial receiving is normal. Only fill in a unit cost if the vendor invoice differs from
            what was ordered.
          </p>
          <form onSubmit={handleReceive} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {lines.map((line) => {
                const remaining = (Number(line.quantity_ordered) - Number(line.quantity_received)).toString();
                return (
                  <div key={line.id} className="grid grid-cols-[1fr_140px_140px] items-center gap-2">
                    <span className="text-sm">
                      {line.product_name}
                      {line.variant_name ? ` — ${line.variant_name}` : ""}
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        {remaining} remaining of {line.quantity_ordered}
                      </span>
                    </span>
                    <input
                      name={`qty_${line.id}`}
                      placeholder={`up to ${remaining}`}
                      className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                    <input
                      name={`cost_${line.id}`}
                      placeholder={line.unit_cost}
                      className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                Vendor invoice #
                <input
                  name="vendor_invoice_no"
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Note
                <input
                  name="note"
                  placeholder="e.g. a discrepancy with the invoice"
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
            >
              {pending ? "Posting..." : "Post receipt"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-sm text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
