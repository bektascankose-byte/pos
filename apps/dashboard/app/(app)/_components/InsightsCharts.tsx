import { formatMinor } from "@/lib/money";
import type { SalesTrendPoint } from "@snappos/contracts";

const W = 720;
const H = 230;
const L = 54;
const R = 20;
const T = 18;
const B = 35;

/*
 * Colours come from the theme tokens through `style`, not SVG attributes:
 * presentation attributes don't resolve var(), and the charts have to follow
 * the dark/light switch like everything else.
 */
const GRID = { stroke: "var(--color-chart-grid)" };
const LABEL = { fill: "var(--color-chart-label)", fontFamily: "var(--font-mono)" };
const SERIES = "var(--color-series-in)";

export function fillSalesDays(points: SalesTrendPoint[], startDate: string, endDate: string): SalesTrendPoint[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const result: SalesTrendPoint[] = [];
  const day = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (day <= end) {
    const date = day.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, sale_count: 0, gross_minor: "0" });
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return result;
}

function axisLabel(minor: number): string {
  const amount = minor / 100;
  return amount >= 1000 ? `$${(amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(amount)}`;
}

function Gridlines({ max, width = W }: { max: number; width?: number }) {
  const plotH = H - T - B;
  return (
    <>
      {[0, 0.5, 1].map((part) => {
        const y = T + part * plotH;
        return (
          <g key={part}>
            <line x1={L} x2={width - R} y1={y} y2={y} style={GRID} strokeDasharray="3 6" />
            <text x={L - 10} y={y + 4} textAnchor="end" style={LABEL} fontSize="10.5">{axisLabel(max * (1 - part))}</text>
          </g>
        );
      })}
    </>
  );
}

export function SalesLineChart({ points }: { points: SalesTrendPoint[] }) {
  if (points.length === 0 || points.every((point) => point.gross_minor === "0")) return <p className="insights-empty">No sales in this period yet.</p>;
  const max = Math.max(1, ...points.map((p) => Number(p.gross_minor)));
  const plotW = W - L - R;
  const plotH = H - T - B;
  const coordinates = points.map((p, i) => ({
    x: L + (points.length === 1 ? plotW / 2 : i * plotW / (points.length - 1)),
    y: T + plotH * (1 - Number(p.gross_minor) / max),
  }));
  const path = coordinates.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  const area = `${path} L ${coordinates[coordinates.length - 1]!.x} ${H - B} L ${coordinates[0]!.x} ${H - B} Z`;
  return (
    <svg className="insights-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily gross sales trend">
      <defs>
        <linearGradient id="sales-area" x1="0" x2="0" y1="0" y2="1">
          <stop style={{ stopColor: SERIES, stopOpacity: 0.32 }} />
          <stop offset="1" style={{ stopColor: SERIES, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <Gridlines max={max} />
      <path d={area} fill="url(#sales-area)" />
      <path d={path} fill="none" style={{ stroke: SERIES, filter: "drop-shadow(0 0 6px var(--color-accent-glow))" }} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      {coordinates.map((p, i) => {
        const point = points[i]!;
        return (
          <g key={point.date}>
            <circle cx={p.x} cy={p.y} r="4.5" style={{ fill: "var(--color-surface)", stroke: SERIES }} strokeWidth="2.4">
              <title>{`${point.date}: ${formatMinor(point.gross_minor)} · ${point.sale_count} sales`}</title>
            </circle>
            <text x={p.x} y={H - 11} textAnchor="middle" style={LABEL} fontSize="10.5">
              {new Date(`${point.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * `compact` draws on a narrower canvas for side panels. The SVG scales to its
 * box, so a 720-wide drawing squeezed into a 400px panel shrank its axis labels
 * to about six pixels; drawing narrower keeps them readable.
 */
export function SalesBarChart({ points, label = "Daily gross sales", compact = false }: { points: SalesTrendPoint[]; label?: string; compact?: boolean }) {
  if (points.length === 0 || points.every((point) => point.gross_minor === "0")) return <p className="insights-empty">No sales in this period yet.</p>;
  const width = compact ? 440 : W;
  const max = Math.max(1, ...points.map((p) => Number(p.gross_minor)));
  const plotW = width - L - R;
  const plotH = H - T - B;
  const slot = plotW / points.length;
  const barW = Math.max(2, Math.min(28, slot * 0.62));
  return (
    <svg className="insights-chart" viewBox={`0 0 ${width} ${H}`} role="img" aria-label={label}>
      <defs>
        <linearGradient id="sales-bar" x1="0" x2="0" y1="0" y2="1">
          <stop style={{ stopColor: "var(--color-cta-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-cta-b)", stopOpacity: 0.55 }} />
        </linearGradient>
      </defs>
      <Gridlines max={max} width={width} />
      {points.map((point, i) => {
        const x = L + i * slot + (slot - barW) / 2;
        const barH = Number(point.gross_minor) / max * plotH;
        const showLabel = points.length <= 10 || i === 0 || i === points.length - 1 || i % 5 === 0;
        return (
          <g key={point.date}>
            <rect x={x} y={T + plotH - barH} width={barW} height={barH} rx="4" fill="url(#sales-bar)">
              <title>{`${point.date}: ${formatMinor(point.gross_minor)} · ${point.sale_count} sales`}</title>
            </rect>
            {showLabel ? <text x={x + barW / 2} y={H - 11} textAnchor="middle" style={LABEL} fontSize="10">{point.date.slice(5)}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}
