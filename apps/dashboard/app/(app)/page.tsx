import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import { NeedsAttentionSection } from "./_components/NeedsAttention";
import { fillSalesDays, SalesBarChart, SalesLineChart } from "./_components/InsightsCharts";
import type { MoneyFlow, NeedsAttention, SalesSummary, SalesTrendPoint } from "@snappos/contracts";

interface SaleRow {
  id: string;
  receipt_no: string;
  status: string;
  total_minor: string;
  completed_at: string | null;
  channel: string;
}

function range(days: number) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function chartDates(days: number): [string, string] {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return [localDate(start), localDate(end)];
}

export default async function DashboardPage() {
  let today: SalesSummary | null = null;
  let week: SalesSummary | null = null;
  let todayFlow: MoneyFlow | null = null;
  let weekTrend: SalesTrendPoint[] = [];
  let monthTrend: SalesTrendPoint[] = [];
  let recent: SaleRow[] = [];
  let attention: NeedsAttention | null = null;
  let error: string | null = null;
  const todayQs = range(1);
  const weekQs = range(7);
  const monthQs = range(30);

  try {
    const storeId = await primaryStoreId();
    [today, week, todayFlow, weekTrend, monthTrend, recent, attention] = await Promise.all([
      apiFetch<SalesSummary>(`/api/v1/reports/sales/summary?${todayQs}`),
      apiFetch<SalesSummary>(`/api/v1/reports/sales/summary?${weekQs}`),
      apiFetch<MoneyFlow>(`/api/v1/reports/money-flow?${todayQs}`),
      apiFetch<SalesTrendPoint[]>(`/api/v1/reports/sales/trend?${weekQs}`),
      apiFetch<SalesTrendPoint[]>(`/api/v1/reports/sales/trend?${monthQs}`),
      apiFetch<{ data: SaleRow[] }>("/api/v1/sales?limit=8").then((r) => r.data),
      apiFetch<NeedsAttention>(`/api/v1/reports/needs-attention${storeId ? `?store_id=${storeId}` : ""}`),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load dashboard data.";
  }

  const lowStock = attention?.low_stock;
  return (
    <div className="insights-page">
      <div className="insights-heading">
        <div>
          <div className="insights-eyebrow">Store overview</div>
          <h1 className="insights-title">Dashboard</h1>
          <p className="insights-subtitle">Your sales, profit, and inventory in one place · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
        </div>
        <div className="insights-actions">
          <Link href="/reports" className="insights-button">↗ &nbsp; View reports</Link>
          <Link href="/catalog/new" className="insights-button primary">＋ &nbsp; Add item</Link>
        </div>
      </div>

      {error ? <div className="insights-panel insights-panel-pad text-sm text-[var(--color-error)]">{error}</div> : (
        <>
          <div className="insights-kpis">
            <Kpi label="Sales today" value={formatMinor(today?.gross_minor ?? "0")} note={`${today?.sale_count ?? 0} completed sales`} icon="↗" />
            <Kpi label="Last 7 days" value={formatMinor(week?.gross_minor ?? "0")} note={`${week?.sale_count ?? 0} completed sales`} icon="▥" />
            <Kpi label="Gross profit today" value={formatMinor(todayFlow?.summary.gross_profit_minor ?? "0")} note={todayFlow?.summary.margin_rate === null ? "No sales yet" : `${((todayFlow?.summary.margin_rate ?? 0) * 100).toFixed(1)}% gross margin`} icon="◔" />
            <Kpi label="Low stock items" value={String(lowStock?.count ?? 0)} note="Below reorder point" icon="!" danger={Boolean(lowStock?.count)} />
          </div>

          <div className="insights-grid">
            <section className="insights-panel">
              <div className="insights-panel-head"><div><h2 className="insights-panel-title">Sales overview</h2><p className="insights-panel-subtitle">Daily gross sales · last 7 days</p></div><Link className="insights-panel-link" href="/reports">Explore →</Link></div>
              <div className="insights-chart-wrap"><SalesLineChart points={fillSalesDays(weekTrend, ...chartDates(7))} /></div>
            </section>
            <section className="insights-panel">
              <div className="insights-panel-head"><div><h2 className="insights-panel-title">Revenue trend</h2><p className="insights-panel-subtitle">Daily gross sales · last 30 days</p></div><span className="insights-eyebrow">30 days</span></div>
              <div className="insights-chart-wrap"><SalesBarChart points={fillSalesDays(monthTrend, ...chartDates(30))} /></div>
            </section>
          </div>

          <div className="insights-grid">
            <section className="insights-panel">
              <div className="insights-panel-head"><div><h2 className="insights-panel-title">Recent sales</h2><p className="insights-panel-subtitle">Latest activity across your store</p></div><Link className="insights-panel-link" href="/reports">View all →</Link></div>
              <div className="insights-table-wrap"><table className="insights-table"><thead><tr><th>Receipt</th><th>Channel</th><th>Completed</th><th>Amount</th><th>Status</th></tr></thead><tbody>
                {recent.map((sale) => <tr key={sale.id}><td className="strong">{sale.receipt_no}</td><td className="capitalize">{sale.channel?.replaceAll("_", " ") ?? "—"}</td><td>{sale.completed_at ? new Date(sale.completed_at).toLocaleString() : "—"}</td><td className="strong numeric">{formatMinor(sale.total_minor)}</td><td><span className={`insights-badge ${sale.status === "completed" ? "" : sale.status === "voided" ? "void" : "pending"}`}>{sale.status}</span></td></tr>)}
                {recent.length === 0 ? <tr><td colSpan={5} className="text-center">No sales yet.</td></tr> : null}
              </tbody></table></div>
            </section>
            <section className="insights-panel">
              <div className="insights-panel-head"><div><h2 className="insights-panel-title">Low stock alert</h2><p className="insights-panel-subtitle">{lowStock?.count ? `${lowStock.count} items need attention` : "Inventory looks healthy"}</p></div><Link className="insights-panel-link" href="/inventory">Manage →</Link></div>
              {lowStock?.items.length ? lowStock.items.slice(0, 5).map((item) => <Link className="insights-alert" key={item.variant_id} href={`/inventory/${item.variant_id}`}><div><div className="insights-alert-name">{item.product_name}{item.variant_name ? ` · ${item.variant_name}` : ""}</div><div className="insights-alert-detail">{Number(item.on_hand)} on hand · reorder at {Number(item.reorder_point)}</div></div><span className="insights-alert-arrow">↗</span></Link>) : <p className="insights-empty">No items are below their reorder point.</p>}
            </section>
          </div>

          <h2 className="insights-section-title">Needs your attention</h2>
          {attention ? <NeedsAttentionSection attention={attention} /> : null}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note, icon, danger = false }: { label: string; value: string; note: string; icon: string; danger?: boolean }) {
  return <div className={`insights-kpi ${danger ? "danger" : ""}`}><div className="insights-kpi-head"><span>{label}</span><span className="insights-kpi-icon" aria-hidden>{icon}</span></div><div className="insights-kpi-value">{value}</div><div className="insights-kpi-note">{note}</div></div>;
}
