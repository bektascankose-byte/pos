import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import type {
  SalesSummary,
  SalesTrendPoint,
  TopProductRow,
  ByCashierRow,
  ByPaymentMethodRow,
} from "@snappos/contracts";

interface DateRange {
  from: string; // ISO, inclusive
  to: string; // ISO, exclusive
  fromDate: string; // YYYY-MM-DD, for the date inputs' defaultValue
  toDateInclusive: string; // YYYY-MM-DD, the last day actually included
}

/** Every preset and the custom form both resolve to this: a day boundary through the day after the last day included, in the server's own timezone -- the same approximation the "Today" card on `/` already makes. */
function dateRange(fromDate: string, toDateInclusive: string): DateRange {
  const from = new Date(`${fromDate}T00:00:00`);
  const toExclusive = new Date(`${toDateInclusive}T00:00:00`);
  toExclusive.setDate(toExclusive.getDate() + 1);
  return {
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    fromDate,
    toDateInclusive,
  };
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveRange(searchParams: { from?: string; to?: string }): DateRange {
  if (searchParams.from && searchParams.to) {
    return dateRange(searchParams.from, searchParams.to);
  }
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  return dateRange(toDateString(from), toDateString(today));
}

const PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 6 },
  { label: "Last 30 days", days: 29 },
];

function presetHref(days: number): string {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  return `/reports?from=${toDateString(from)}&to=${toDateString(today)}`;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const range = resolveRange(params);

  let summary: SalesSummary | null = null;
  let trend: SalesTrendPoint[] = [];
  let topProducts: TopProductRow[] = [];
  let byCashier: ByCashierRow[] = [];
  let byPaymentMethod: ByPaymentMethodRow[] = [];
  let error: string | null = null;

  const qs = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

  try {
    [summary, trend, topProducts, byCashier, byPaymentMethod] = await Promise.all([
      apiFetch<SalesSummary>(`/api/v1/reports/sales/summary?${qs}`),
      apiFetch<SalesTrendPoint[]>(`/api/v1/reports/sales/trend?${qs}`),
      apiFetch<TopProductRow[]>(`/api/v1/reports/sales/top-products?${qs}&limit=10`),
      apiFetch<ByCashierRow[]>(`/api/v1/reports/sales/by-cashier?${qs}`),
      apiFetch<ByPaymentMethodRow[]>(`/api/v1/reports/sales/by-payment-method?${qs}`),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load this report.";
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Reports</h1>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <form className="flex items-end gap-2" action="/reports">
          <label className="flex flex-col gap-1 text-sm">
            From
            <input
              type="date"
              name="from"
              defaultValue={range.fromDate}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            To
            <input
              type="date"
              name="to"
              defaultValue={range.toDateInclusive}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          >
            Apply
          </button>
        </form>
        <div className="flex gap-2 text-sm">
          {PRESETS.map((preset) => (
            <a
              key={preset.label}
              href={presetHref(preset.days)}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg)]"
            >
              {preset.label}
            </a>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-[var(--color-error)]">{error}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryCard label="Sales" value={String(summary?.sale_count ?? 0)} />
            <SummaryCard label="Gross" value={formatMinor(summary?.gross_minor ?? "0")} />
            <SummaryCard label="Average ticket" value={formatMinor(summary?.average_ticket_minor ?? "0")} />
          </div>

          <TrendChart points={trend} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Top products">
              <table className="w-full text-sm">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-3 py-2 font-normal">Product</th>
                    <th className="px-3 py-2 font-normal">Qty</th>
                    <th className="px-3 py-2 font-normal">Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {topProducts.map((row) => (
                    <tr key={row.product_id} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2">
                        {row.product_name}
                        {row.category_name ? (
                          <span className="block text-xs text-[var(--color-text-muted)]">
                            {row.category_name}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{row.quantity}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMinor(row.gross_minor)}</td>
                    </tr>
                  ))}
                  {topProducts.length === 0 ? <EmptyRow colSpan={3} /> : null}
                </tbody>
              </table>
            </Panel>

            <Panel title="By cashier">
              <table className="w-full text-sm">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-3 py-2 font-normal">Cashier</th>
                    <th className="px-3 py-2 font-normal">Sales</th>
                    <th className="px-3 py-2 font-normal">Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {byCashier.map((row) => (
                    <tr key={row.cashier_user_id} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2">{row.cashier_name}</td>
                      <td className="px-3 py-2 tabular-nums">{row.sale_count}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMinor(row.gross_minor)}</td>
                    </tr>
                  ))}
                  {byCashier.length === 0 ? <EmptyRow colSpan={3} /> : null}
                </tbody>
              </table>
            </Panel>

            <Panel title="By payment method">
              <table className="w-full text-sm">
                <thead className="text-left text-[var(--color-text-muted)]">
                  <tr>
                    <th className="px-3 py-2 font-normal">Method</th>
                    <th className="px-3 py-2 font-normal">Count</th>
                    <th className="px-3 py-2 font-normal">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {byPaymentMethod.map((row) => (
                    <tr key={row.method} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2 capitalize">{row.method.replace("_", " ")}</td>
                      <td className="px-3 py-2 tabular-nums">{row.payment_count}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMinor(row.amount_minor)}</td>
                    </tr>
                  ))}
                  {byPaymentMethod.length === 0 ? <EmptyRow colSpan={3} /> : null}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">{title}</div>
      {children}
    </div>
  );
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
        No data for this range.
      </td>
    </tr>
  );
}

/** A plain inline SVG bar chart -- no charting library for one bar-per-day, and it keeps the page free of client-side JS. */
function TrendChart({ points }: { points: SalesTrendPoint[] }) {
  const width = 720;
  const height = 200;
  const padding = 24;
  const maxGross = Math.max(1, ...points.map((p) => Number(p.gross_minor)));
  const barWidth = points.length > 0 ? (width - padding * 2) / points.length : 0;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Daily gross sales</div>
      {points.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No data for this range.</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Daily gross sales">
          {points.map((point, i) => {
            const gross = Number(point.gross_minor);
            const barHeight = (gross / maxGross) * (height - padding * 2);
            const x = padding + i * barWidth;
            const y = height - padding - barHeight;
            return (
              <g key={point.date}>
                <rect
                  x={x + barWidth * 0.15}
                  y={y}
                  width={barWidth * 0.7}
                  height={barHeight}
                  fill="var(--color-accent)"
                  rx={2}
                >
                  <title>
                    {point.date}: {formatMinor(point.gross_minor)} ({point.sale_count} sales)
                  </title>
                </rect>
                {points.length <= 14 ? (
                  <text
                    x={x + barWidth / 2}
                    y={height - padding + 14}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--color-text-muted)"
                  >
                    {point.date.slice(5)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
