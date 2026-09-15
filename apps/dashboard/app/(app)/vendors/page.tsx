import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import type { VendorListRow } from "@snappos/contracts";

/**
 * "3 days ago" reads faster than a date when the question is "are we still
 * buying from them".
 *
 * Counted in calendar days, not in elapsed hours: something from the evening
 * of the 13th is "2 days ago" on the 15th, and dividing the milliseconds
 * would call it yesterday.
 */
function relativeDay(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(then)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return then.toLocaleDateString();
}

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { q, status } = await searchParams;
  const showingArchived = status === "archived";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (showingArchived) params.set("status", "archived");
  const qs = params.toString() ? `?${params}` : "";

  let vendors: VendorListRow[] = [];
  let error: string | null = null;
  try {
    vendors = await apiFetch<VendorListRow[]>(`/api/v1/purchasing/vendors${qs}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load vendors.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Vendors</h1>
        <Link
          href="/vendors/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Add vendor
        </Link>
      </div>

      <form className="flex items-center gap-2">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by name or code"
          className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        {showingArchived ? <input type="hidden" name="status" value="archived" /> : null}
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
        >
          Search
        </button>
        <Link
          href={showingArchived ? `/vendors${q ? `?q=${encodeURIComponent(q)}` : ""}` : "/vendors?status=archived"}
          className="text-sm text-[var(--color-accent)] underline"
        >
          {showingArchived ? "Show active" : "Show archived"}
        </Link>
      </form>

      {showingArchived ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Archived vendors. They can&apos;t be picked for a new purchase order or invoice, and their
          past orders are untouched.
        </p>
      ) : null}

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Vendor</th>
              <th className="px-4 py-2 font-normal">Contact</th>
              <th className="px-4 py-2 font-normal">Terms</th>
              <th className="px-4 py-2 text-right font-normal">Items</th>
              <th className="px-4 py-2 text-right font-normal">Open POs</th>
              <th className="px-4 py-2 font-normal">Last invoice</th>
              <th className="px-4 py-2 text-right font-normal">Minimum</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((vendor) => (
              <tr key={vendor.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/vendors/${vendor.id}`} className="text-[var(--color-accent)]">
                    {vendor.name}
                  </Link>
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">{vendor.code}</span>
                </td>
                <td className="px-4 py-2">
                  {vendor.sales_rep_name ?? vendor.contact_name ?? "—"}
                  {vendor.sales_rep_phone || vendor.phone ? (
                    <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                      {vendor.sales_rep_phone ?? vendor.phone}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2">{vendor.payment_terms ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{vendor.item_count}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {vendor.open_po_count > 0 ? vendor.open_po_count : "—"}
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {relativeDay(vendor.last_invoice_at)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {vendor.minimum_order_minor === "0" ? "—" : formatMinor(vendor.minimum_order_minor)}
                </td>
              </tr>
            ))}
            {vendors.length === 0 && !error ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  {q
                    ? `No match for "${q}".`
                    : showingArchived
                      ? "Nothing archived."
                      : "No vendors yet. Add the ones you buy from, or let an invoice tell you."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
