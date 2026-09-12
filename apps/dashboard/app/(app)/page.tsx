import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import type { SalesSummary } from "@snappos/contracts";

interface SaleRow {
  id: string;
  receipt_no: string;
  status: string;
  total_minor: string;
  tax_minor: string;
  completed_at: string | null;
  channel: string;
}

/**
 * Start of today through start of tomorrow, in the server's own timezone.
 * A single-store US shop this ships to first makes that an acceptable
 * approximation for v1 -- a store-configurable timezone is a real gap for a
 * multi-region deployment, and worth fixing before this app supports one.
 */
function todayRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export default async function DashboardPage() {
  const { from, to } = todayRange();

  let summary: SalesSummary | null = null;
  let recent: SaleRow[] = [];
  let error: string | null = null;

  try {
    [summary, recent] = await Promise.all([
      apiFetch<SalesSummary>(`/api/v1/reports/sales/summary?from=${from}&to=${to}`),
      apiFetch<{ data: SaleRow[] }>(`/api/v1/sales?limit=20`).then((r) => r.data),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load today's numbers.";
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Today</h1>

      {error ? (
        <p className="text-sm text-[var(--color-error)]">{error}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard label="Sales" value={String(summary?.sale_count ?? 0)} />
          <SummaryCard label="Gross" value={formatMinor(summary?.gross_minor ?? "0")} />
          <SummaryCard label="Average ticket" value={formatMinor(summary?.average_ticket_minor ?? "0")} />
        </div>
      )}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
          Recent sales
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Receipt</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Total</th>
              <th className="px-4 py-2 font-normal">Completed</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((sale) => (
              <tr key={sale.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">{sale.receipt_no}</td>
                <td className="px-4 py-2 capitalize">{sale.status}</td>
                <td className="px-4 py-2">{formatMinor(sale.total_minor)}</td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {sale.completed_at ? new Date(sale.completed_at).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
            {recent.length === 0 && !error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No sales yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
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
