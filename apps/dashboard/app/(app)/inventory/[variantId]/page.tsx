import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { postAdjustmentAction } from "../actions";
import type { StockLevelRow, LedgerEntry } from "@snappos/contracts";

const MANUAL_REASONS = [
  { id: "receiving", name: "Receiving (no PO)" },
  { id: "count_adjustment", name: "Count adjustment" },
  { id: "damage", name: "Damage" },
  { id: "expired", name: "Expired" },
  { id: "theft", name: "Theft" },
  { id: "vendor_return", name: "Vendor return" },
  { id: "promo_giveaway", name: "Promo giveaway" },
  { id: "manual_adjustment", name: "Manual adjustment (other)" },
  { id: "opening_balance", name: "Opening balance" },
];

export default async function InventoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { variantId } = await params;
  const { saved, error } = await searchParams;

  const storeId = await primaryStoreId();
  if (!storeId) notFound();

  let stock: StockLevelRow;
  let ledger: LedgerEntry[] = [];
  try {
    [stock, ledger] = await Promise.all([
      apiFetch<StockLevelRow>(`/api/v1/inventory/stock/${variantId}?store_id=${storeId}`),
      apiFetch<LedgerEntry[]>(`/api/v1/inventory/ledger?variant_id=${variantId}&limit=20`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  const postAdjustment = postAdjustmentAction.bind(null, variantId, storeId);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">
        {stock.product_name}
        {stock.variant_name ? ` — ${stock.variant_name}` : ""}
      </h1>
      <p className="-mt-4 text-sm text-[var(--color-text-muted)]">{stock.sku}</p>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="On hand" value={stock.on_hand} />
        <SummaryCard label="Reserved" value={stock.reserved} />
        <SummaryCard label="Available" value={stock.available} />
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Adjust stock</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A positive quantity adds stock, a negative quantity removes it. This posts a new movement
          to the ledger -- it never edits history.
        </p>
        <form action={postAdjustment} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Reason
              <select
                name="reason"
                required
                defaultValue=""
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              >
                <option value="" disabled>
                  Choose a reason
                </option>
                {MANUAL_REASONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Quantity (+/-)
              <input
                name="delta"
                required
                placeholder="e.g. -1 or 24"
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Note
            <input
              name="note"
              placeholder="required for damage, theft, expired, and other adjustments"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Post adjustment
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
          Recent movements
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">When</th>
              <th className="px-4 py-2 font-normal">Reason</th>
              <th className="px-4 py-2 font-normal">Qty</th>
              <th className="px-4 py-2 font-normal">Note</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(entry.occurred_at).toLocaleString()}
                </td>
                <td className="px-4 py-2 capitalize">{entry.reason.replace("_", " ")}</td>
                <td className="px-4 py-2 tabular-nums">{entry.delta}</td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">{entry.note ?? "—"}</td>
              </tr>
            ))}
            {ledger.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No movements yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
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
