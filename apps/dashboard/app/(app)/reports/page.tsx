import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import type { SalesSummary, SalesTrendPoint, TopProductRow, ByCashierRow, ByPaymentMethodRow, MoneyFlow, VendorSpendRow } from "@snappos/contracts";
import { fillSalesDays, SalesBarChart } from "../_components/InsightsCharts";
import { MoneyFlowSection, VendorSpendPanel } from "./MoneyFlow";

interface DateRange { from: string; to: string; fromDate: string; toDateInclusive: string; }
const PRESETS = [{ label: "Today", days: 0 }, { label: "Last 7 days", days: 6 }, { label: "Last 30 days", days: 29 }];

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dateRange(fromDate: string, toDateInclusive: string): DateRange {
  const start = new Date(`${fromDate}T00:00:00`);
  const end = new Date(`${toDateInclusive}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString(), fromDate, toDateInclusive };
}
function resolveRange(params: { from?: string; to?: string }): DateRange {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (params.from && params.to && datePattern.test(params.from) && datePattern.test(params.to) && params.from <= params.to && !Number.isNaN(new Date(`${params.from}T00:00:00`).getTime()) && !Number.isNaN(new Date(`${params.to}T00:00:00`).getTime())) {
    return dateRange(params.from, params.to);
  }
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  return dateRange(localDate(start), localDate(today));
}
function presetHref(days: number): string {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  return `/reports?from=${localDate(start)}&to=${localDate(today)}`;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const range = resolveRange(await searchParams);
  const qs = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  let summary: SalesSummary | null = null;
  let trend: SalesTrendPoint[] = [];
  let topProducts: TopProductRow[] = [];
  let byCashier: ByCashierRow[] = [];
  let byPaymentMethod: ByPaymentMethodRow[] = [];
  let moneyFlow: MoneyFlow | null = null;
  let vendorSpend: VendorSpendRow[] = [];
  let error: string | null = null;
  try {
    [summary, trend, topProducts, byCashier, byPaymentMethod, moneyFlow, vendorSpend] = await Promise.all([
      apiFetch<SalesSummary>(`/api/v1/reports/sales/summary?${qs}`),
      apiFetch<SalesTrendPoint[]>(`/api/v1/reports/sales/trend?${qs}`),
      apiFetch<TopProductRow[]>(`/api/v1/reports/sales/top-products?${qs}&limit=10`),
      apiFetch<ByCashierRow[]>(`/api/v1/reports/sales/by-cashier?${qs}`),
      apiFetch<ByPaymentMethodRow[]>(`/api/v1/reports/sales/by-payment-method?${qs}`),
      apiFetch<MoneyFlow>(`/api/v1/reports/money-flow?${qs}`),
      apiFetch<VendorSpendRow[]>(`/api/v1/reports/vendor-spend?${qs}`),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load this report.";
  }
  const period = `${new Date(`${range.fromDate}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(`${range.toDateInclusive}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  const maxProduct = Math.max(1, ...topProducts.map((row) => Number(row.gross_minor)));
  const maxCashier = Math.max(1, ...byCashier.map((row) => Number(row.gross_minor)));
  const maxPayment = Math.max(1, ...byPaymentMethod.map((row) => Number(row.amount_minor)));
  return (
    <div className="insights-page">
      <div className="insights-heading">
        <div><div className="insights-eyebrow">Business intelligence</div><h1 className="insights-title">Reports & analytics</h1><p className="insights-subtitle">See what is selling, where money is going, and how your team is performing.</p></div>
        <Link href="/" className="insights-button">← &nbsp; Dashboard</Link>
      </div>

      <div className="insights-panel insights-filter">
        <div className="insights-periods">
          {PRESETS.map((preset) => {
            const href = presetHref(preset.days);
            return <a key={preset.label} href={href} className={href === `/reports?from=${range.fromDate}&to=${range.toDateInclusive}` ? "selected" : ""}>{preset.label}</a>;
          })}
        </div>
        <form action="/reports"><label>From<input type="date" name="from" defaultValue={range.fromDate} required /></label><label>To<input type="date" name="to" defaultValue={range.toDateInclusive} required /></label><button type="submit" className="insights-button primary">Apply range</button></form>
      </div>

      {error ? <div className="insights-panel insights-panel-pad text-sm text-[var(--color-error)]">{error}</div> : (
        <>
          <div className="insights-kpis">
            <Kpi label="Gross sales" value={formatMinor(summary?.gross_minor ?? "0")} note={period} icon="↗" />
            <Kpi label="Gross profit" value={formatMinor(moneyFlow?.summary.gross_profit_minor ?? "0")} note={moneyFlow?.summary.margin_rate === null ? "No sales in range" : `${((moneyFlow?.summary.margin_rate ?? 0) * 100).toFixed(1)}% gross margin`} icon="◔" danger={BigInt(moneyFlow?.summary.gross_profit_minor ?? "0") < 0n} />
            <Kpi label="Sales completed" value={String(summary?.sale_count ?? 0)} note="Transactions in selected range" icon="▥" />
            <Kpi label="Average ticket" value={formatMinor(summary?.average_ticket_minor ?? "0")} note="Per completed sale" icon="◫" />
          </div>

          <div className="insights-grid">
            <section className="insights-panel"><div className="insights-panel-head"><div><h2 className="insights-panel-title">Sales over time</h2><p className="insights-panel-subtitle">Daily gross sales · {period}</p></div><span className="insights-eyebrow">Daily</span></div><div className="insights-chart-wrap"><SalesBarChart points={fillSalesDays(trend, range.fromDate, range.toDateInclusive)} /></div></section>
            <section className="insights-panel"><div className="insights-panel-head"><div><h2 className="insights-panel-title">Performance snapshot</h2><p className="insights-panel-subtitle">A closer look at the selected period</p></div></div>
              <div className="insights-split-row"><span className="insights-split-name">Sales tax collected</span><span className="insights-split-value">{formatMinor(summary?.tax_minor ?? "0")}</span></div>
              <div className="insights-split-row"><span className="insights-split-name">Cost of goods sold</span><span className="insights-split-value">{formatMinor(moneyFlow?.summary.cogs_minor ?? "0")}</span></div>
              <div className="insights-split-row"><span className="insights-split-name">Vendor purchases invoiced</span><span className="insights-split-value">{formatMinor(moneyFlow?.summary.purchases_minor ?? "0")}</span></div>
              <div className="insights-split-row"><span className="insights-split-name">Vendor invoices counted</span><span className="insights-split-value">{moneyFlow?.summary.invoice_count ?? 0}</span></div>
            </section>
          </div>

          {moneyFlow ? <MoneyFlowSection flow={moneyFlow} /> : null}

          <div className="insights-grid">
            <Breakdown title="Top products" subtitle="Best sellers by gross sales" empty="No products sold in this range.">
              {topProducts.length ? topProducts.map((row) => <div className="insights-split-row" key={row.product_id}><div className="min-w-0 flex-1"><div className="flex justify-between gap-3"><span className="insights-split-name truncate">{row.product_name}</span><span className="insights-split-value">{formatMinor(row.gross_minor)}</span></div><div className="mt-2 insights-meter"><span style={{ width: `${Math.max(2, Number(row.gross_minor) / maxProduct * 100)}%` }} /></div><div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{row.quantity} sold{row.category_name ? ` · ${row.category_name}` : ""}</div></div></div>) : null}
            </Breakdown>
            <div className="flex min-w-0 flex-col gap-4">
              <Breakdown title="By payment method" subtitle="Where sales payments came from" empty="No payments in this range.">
                {byPaymentMethod.length ? byPaymentMethod.map((row) => <div className="insights-split-row" key={row.method}><div className="min-w-0 flex-1"><div className="flex justify-between gap-3"><span className="insights-split-name capitalize">{row.method.replaceAll("_", " ")}</span><span className="insights-split-value">{formatMinor(row.amount_minor)}</span></div><div className="mt-2 insights-meter"><span style={{ width: `${Math.max(2, Number(row.amount_minor) / maxPayment * 100)}%` }} /></div><div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{row.payment_count} payments</div></div></div>) : null}
              </Breakdown>
              <Breakdown title="By cashier" subtitle="Sales attributed to each team member" empty="No cashier sales in this range.">
                {byCashier.length ? byCashier.map((row) => <div className="insights-split-row" key={row.cashier_user_id}><div className="min-w-0 flex-1"><div className="flex justify-between gap-3"><span className="insights-split-name truncate">{row.cashier_name}</span><span className="insights-split-value">{formatMinor(row.gross_minor)}</span></div><div className="mt-2 insights-meter"><span style={{ width: `${Math.max(2, Number(row.gross_minor) / maxCashier * 100)}%` }} /></div><div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{row.sale_count} sales</div></div></div>) : null}
              </Breakdown>
            </div>
          </div>
          <VendorSpendPanel rows={vendorSpend} />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note, icon, danger = false }: { label: string; value: string; note: string; icon: string; danger?: boolean }) {
  return <div className={`insights-kpi ${danger ? "danger" : ""}`}><div className="insights-kpi-head"><span>{label}</span><span className="insights-kpi-icon" aria-hidden>{icon}</span></div><div className="insights-kpi-value">{value}</div><div className="insights-kpi-note">{note}</div></div>;
}
function Breakdown({ title, subtitle, empty, children }: { title: string; subtitle: string; empty: string; children: React.ReactNode }) {
  return <section className="insights-panel"><div className="insights-panel-head"><div><h2 className="insights-panel-title">{title}</h2><p className="insights-panel-subtitle">{subtitle}</p></div></div>{children || <p className="insights-empty">{empty}</p>}</section>;
}
