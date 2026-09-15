import { formatMinor } from "@/lib/money";
import type { MoneyFlow, VendorSpendRow } from "@snappos/contracts";

/**
 * Money out against money in.
 *
 * The two series are not measured the same way and this refuses to pretend
 * otherwise. Sales are recorded as they happen, so a day's bar is exact.
 * Purchases are vendor invoices dated that day — lumpy by nature, since one
 * delivery lands a month of stock on a single date — and only counts invoices
 * that have been uploaded at all. Both caveats are printed under the chart
 * rather than left for someone to discover by disbelieving their own numbers.
 */
export function MoneyFlowSection({ flow }: { flow: MoneyFlow }) {
  const { summary, points } = flow;
  const hasAny = points.some((p) => p.sales_minor !== "0" || p.purchases_minor !== "0");

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card label="Sales" value={formatMinor(summary.sales_minor)} tone="in" />
        <Card
          label="Cost of goods sold"
          value={formatMinor(summary.cogs_minor)}
          note="what those sales cost you"
        />
        <Card
          label="Gross profit"
          value={formatMinor(summary.gross_profit_minor)}
          note={
            summary.margin_rate === null
              ? "nothing sold in this range"
              : `${(summary.margin_rate * 100).toFixed(1)}% margin`
          }
          tone={BigInt(summary.gross_profit_minor) < 0n ? "bad" : "in"}
        />
        <Card
          label="Purchases invoiced"
          value={formatMinor(summary.purchases_minor)}
          note={
            summary.invoice_count === 0
              ? "no dated invoices in this range"
              : `${summary.invoice_count} invoice${summary.invoice_count === 1 ? "" : "s"}`
          }
          tone="out"
        />
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-[var(--color-text-muted)]">Purchases vs sales</div>
          <div className="flex gap-4 text-xs text-[var(--color-text-muted)]">
            <Key color="var(--color-series-in)" label="Sales" />
            <Key color="var(--color-series-out)" label="Purchases" />
          </div>
        </div>

        {!hasAny ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Nothing sold or invoiced in this range.
          </p>
        ) : (
          <PairedBars points={points} />
        )}

        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Sales are counted on the day they happened. Purchases are counted on the date the vendor put
          on the invoice — so they arrive in lumps, and a day with no bar means no invoice was dated
          that day, not that nothing was bought.
          {summary.undated_invoice_count > 0 ? (
            <>
              {" "}
              <strong className="font-medium text-[var(--color-text)]">
                {summary.undated_invoice_count} invoice
                {summary.undated_invoice_count === 1 ? " has" : "s have"} no date
              </strong>{" "}
              and {summary.undated_invoice_count === 1 ? "is" : "are"} not in this chart or the
              purchases total.
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}

/**
 * Two bars per day, sharing one scale so their heights are comparable — the
 * whole point is reading one against the other, which separate scales would
 * quietly destroy.
 */
function PairedBars({ points }: { points: MoneyFlow["points"] }) {
  const width = 720;
  const height = 220;
  const padding = 28;
  const plotHeight = height - padding * 2;

  const max = Math.max(
    1,
    ...points.map((p) => Math.max(Number(p.sales_minor), Number(p.purchases_minor))),
  );
  const slot = (width - padding * 2) / Math.max(points.length, 1);
  const barWidth = Math.max(1, (slot * 0.8) / 2);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Daily sales against vendor purchases"
    >
      {/* Baseline, so a day of zeroes still reads as a day rather than a gap. */}
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        stroke="var(--color-border)"
      />
      {points.map((point, i) => {
        const left = padding + i * slot + slot * 0.1;
        const bars = [
          { value: Number(point.sales_minor), color: "var(--color-series-in)", label: "sales" },
          { value: Number(point.purchases_minor), color: "var(--color-series-out)", label: "purchases" },
        ];
        return (
          <g key={point.date}>
            {bars.map((bar, b) => {
              const barHeight = (bar.value / max) * plotHeight;
              return (
                <rect
                  key={bar.label}
                  x={left + b * barWidth}
                  y={height - padding - barHeight}
                  width={barWidth}
                  height={barHeight}
                  fill={bar.color}
                  rx={1}
                >
                  <title>
                    {point.date} · {bar.label} {formatMinor(String(bar.value))}
                  </title>
                </rect>
              );
            })}
            {points.length <= 14 ? (
              <text
                x={left + barWidth}
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
  );
}

/**
 * What each vendor was invoiced and what their paperwork says is still owed.
 *
 * Says "per the invoice" out loud: `amount_paid` is whatever the vendor's own
 * document claimed when it was uploaded, so a payment made afterwards is
 * invisible here. Presenting this as accounts payable would be a lie.
 */
export function VendorSpendPanel({ rows }: { rows: VendorSpendRow[] }) {
  const owed = rows.reduce((sum, r) => sum + BigInt(r.outstanding_minor), 0n);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-3">
        <span className="text-sm font-medium">Spend by vendor</span>
        {owed > 0n ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            {formatMinor(owed.toString())} outstanding per the invoices
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[var(--color-text-muted)]">
          No dated vendor invoices in this range.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Vendor</th>
                <th className="px-4 py-2 font-normal">Invoices</th>
                <th className="px-4 py-2 text-right font-normal">Invoiced</th>
                <th className="px-4 py-2 text-right font-normal">Paid</th>
                <th className="px-4 py-2 text-right font-normal">Outstanding</th>
                <th className="px-4 py-2 font-normal">Last invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {rows.map((row) => (
                <tr key={row.vendor_id ?? "unfiled"}>
                  <td className="px-4 py-2">
                    {row.vendor_name ?? (
                      <span className="text-[var(--color-text-muted)]">not filed under a vendor</span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{row.invoice_count}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMinor(row.invoiced_minor)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--color-text-muted)]">
                    {formatMinor(row.paid_minor)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {BigInt(row.outstanding_minor) > 0n ? formatMinor(row.outstanding_minor) : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--color-text-muted)]">
                    {row.last_invoice_date ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "in" | "out" | "bad";
}) {
  const color =
    tone === "in"
      ? "var(--color-series-in)"
      : tone === "out"
        ? "var(--color-series-out)"
        : tone === "bad"
          ? "var(--color-error)"
          : "var(--color-text)";

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      {note ? <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{note}</div> : null}
    </div>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
