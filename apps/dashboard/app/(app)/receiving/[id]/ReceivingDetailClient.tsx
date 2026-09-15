"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ScanPanel } from "./ScanPanel";
import { IdentifyLine, type PriceGroupOption } from "./IdentifyLine";
import {
  removeLineAction,
  updateLineAction,
  commitSessionAction,
  unverifySessionAction,
  matchInvoiceAction,
} from "../actions";
import type { LookupOption } from "../../catalog/LookupSelect";
import type { ReceivingSession, ReceivingLine, ReceivingMatch, InvoiceImport } from "@snappos/contracts";

export function ReceivingDetailClient({
  initialSession,
  categories: initialCategories,
  brands: initialBrands,
  priceGroups: initialPriceGroups,
  invoices,
}: {
  initialSession: ReceivingSession;
  categories: LookupOption[];
  brands: LookupOption[];
  priceGroups: PriceGroupOption[];
  invoices: InvoiceImport[];
}) {
  const [session, setSession] = useState(initialSession);
  const [identifying, setIdentifying] = useState<ReceivingLine | null>(null);
  const [match, setMatch] = useState<ReceivingMatch | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const [categories, setCategories] = useState(initialCategories);
  const [brands, setBrands] = useState(initialBrands);
  const [priceGroups, setPriceGroups] = useState(initialPriceGroups);

  const lines = session.lines ?? [];
  const open = session.status === "open";
  const unresolved = lines.filter((line) => !line.variant_id);

  const run = <T,>(
    action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    onOk: (data: T) => void,
  ) => {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) onOk(result.data);
      else setMessage({ kind: "error", text: result.error });
    });
  };

  const commit = () =>
    run(
      () => commitSessionAction(session.id),
      (updated) => {
        setSession(updated);
        setMessage({
          kind: "success",
          text: `${updated.line_count} line${updated.line_count === 1 ? "" : "s"} went into stock.`,
        });
      },
    );

  const unverify = () =>
    run(
      () => unverifySessionAction(session.id),
      (updated) => {
        setSession(updated);
        setMessage({
          kind: "success",
          text: "Taken back out of stock — edit what you need, then verify again.",
        });
      },
    );

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{session.reference || "Delivery"}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {session.vendor_name ?? "no vendor yet"} · {lines.length} line
            {lines.length === 1 ? "" : "s"} ·{" "}
            {session.status === "open"
              ? "counting"
              : session.status === "committed"
                ? "in stock"
                : "cancelled"}
          </p>
        </div>
        <Link href="/receiving" className="text-sm text-[var(--color-accent)]">
          ← All deliveries
        </Link>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      {open ? <ScanPanel sessionId={session.id} onUpdated={setSession} /> : null}

      {lines.length > 0 ? (
        <section className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
            What was counted
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Item</th>
                <th className="px-4 py-2 font-normal">Scanned</th>
                <th className="px-4 py-2 text-right font-normal">Qty</th>
                <th className="px-4 py-2 text-right font-normal">Unit cost</th>
                <th className="px-4 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    {line.variant_id ? (
                      <>
                        {line.product_name}
                        {line.variant_name ? ` — ${line.variant_name}` : ""}
                        {/* An item this scan created from the old system's file
                            carries that file's price. Worth a glance before it
                            becomes sellable, so the row says so. */}
                        {line.filled_from_reference ? (
                          <span className="mt-0.5 block text-[0.7rem] text-[var(--color-text-muted)]">
                            new item, filled in from your Modisoft file — check its price
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-[var(--color-error)]">Not in the catalog</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{line.scanned_code}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {open ? (
                      <InlineNumber
                        value={String(Number(line.quantity))}
                        disabled={pending}
                        onCommit={(next) =>
                          run(() => updateLineAction(session.id, line.id, { quantity: next }), setSession)
                        }
                      />
                    ) : (
                      Number(line.quantity)
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {open ? (
                      <InlineNumber
                        value={line.unit_cost ? String(Number(line.unit_cost)) : ""}
                        placeholder="—"
                        disabled={pending}
                        onCommit={(next) =>
                          run(() => updateLineAction(session.id, line.id, { unit_cost: next }), setSession)
                        }
                      />
                    ) : line.unit_cost ? (
                      `$${Number(line.unit_cost)}`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {open ? (
                      <div className="flex justify-end gap-1">
                        {line.variant_id ? null : (
                          <button
                            type="button"
                            onClick={() => setIdentifying(line)}
                            className="rounded-md border border-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-accent)]"
                          >
                            Identify
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(
                              () => updateLineAction(session.id, line.id, {
                                quantity: String(Number(line.quantity) + 1),
                              }),
                              setSession,
                            )
                          }
                          title="One more of these"
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                        >
                          +1
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => removeLineAction(session.id, line.id), setSession)}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-error)] disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {open ? (
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-medium">Put it into stock</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            {unresolved.length > 0
              ? `${unresolved.length} scanned code${unresolved.length === 1 ? "" : "s"} still need${unresolved.length === 1 ? "s" : ""} naming — an unknown code would put the count on the wrong item.`
              : lines.length === 0
                ? "Nothing scanned yet."
                : `${lines.length} line${lines.length === 1 ? "" : "s"} will be received. You can unverify afterwards to change them.`}
          </p>
          <button
            type="button"
            disabled={pending || lines.length === 0 || unresolved.length > 0}
            onClick={commit}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Receiving..." : "Verify — receive into stock"}
          </button>
        </section>
      ) : null}

      {session.status === "committed" ? (
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-medium">Need to change something?</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Unverifying takes these {lines.length} line{lines.length === 1 ? "" : "s"} back out of your
            shelf figures so you can add, remove or correct them, then verify again. Nothing is deleted:
            the stock going in and coming back out both stay on the record, because both happened.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={unverify}
            className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            {pending ? "Working..." : "Unverify — take back out of stock"}
          </button>
        </section>
      ) : null}

      {/*
        Invoice matching is offered whatever the session's state. The whole
        point is that the paperwork shows up late -- often after the stock is
        already on the shelf -- and checking it against what was counted is
        still worth doing then.
      */}
      <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div>
          <h2 className="text-sm font-medium">Check against the invoice</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            Upload and parse the invoice under Invoices first, then match it here. Comparison is by
            UPC against the items each invoice line was resolved to.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <select
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            <option value="">Choose a parsed invoice</option>
            {invoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.source_filename}
                {invoice.vendor_name ? ` · ${invoice.vendor_name}` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !invoiceId}
            onClick={() => run(() => matchInvoiceAction(session.id, invoiceId), setMatch)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            {pending ? "Checking..." : "Check it"}
          </button>
        </div>

        {match ? <MatchReport match={match} /> : null}
      </section>

      {identifying ? (
        <IdentifyLine
          sessionId={session.id}
          line={identifying}
          categories={categories}
          brands={brands}
          priceGroups={priceGroups}
          onCategoryCreated={(option) => setCategories((prev) => [...prev, option])}
          onBrandCreated={(option) => setBrands((prev) => [...prev, option])}
          onPriceGroupCreated={(option) =>
            setPriceGroups((prev) => [...prev, { ...option, price_minor: null }])
          }
          onClose={() => setIdentifying(null)}
          onCreated={(updated) => {
            setIdentifying(null);
            setSession(updated);
            setMessage({ kind: "success", text: "Item created and matched." });
          }}
        />
      ) : null}
    </div>
  );
}

function MatchReport({ match }: { match: ReceivingMatch }) {
  const disagreeing = match.matched.filter((row) => Number(row.difference) !== 0);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <ul className="flex flex-col gap-1 text-sm">
        {match.warnings.map((warning) => (
          <li
            key={warning}
            className={
              warning.startsWith("Everything")
                ? "text-[var(--color-success)]"
                : "text-[var(--color-error)]"
            }
          >
            {warning}
          </li>
        ))}
      </ul>

      {match.invoiced_not_received.length > 0 ? (
        <MatchList
          title="Billed but never scanned"
          hint="Short-shipped, still in the van, or an invoice line nobody matched to an item."
          rows={match.invoiced_not_received.map((row) => ({
            label: row.label,
            detail: row.invoiced_quantity ? `${Number(row.invoiced_quantity)} billed` : "quantity unknown",
          }))}
        />
      ) : null}

      {disagreeing.length > 0 ? (
        <MatchList
          title="Counted a different number than billed"
          rows={disagreeing.map((row) => ({
            label: row.label,
            detail: `${Number(row.received_quantity)} counted vs ${Number(row.invoiced_quantity ?? 0)} billed (${
              Number(row.difference) > 0 ? "+" : ""
            }${row.difference})`,
          }))}
        />
      ) : null}

      {match.received_not_invoiced.length > 0 ? (
        <MatchList
          title="Scanned but not on this invoice"
          hint="A different delivery, or something thrown in unbilled."
          rows={match.received_not_invoiced.map((row) => ({
            label: row.label,
            detail: `${Number(row.received_quantity)} counted`,
          }))}
        />
      ) : null}
    </div>
  );
}

function MatchList({
  title,
  hint,
  rows,
}: {
  title: string;
  hint?: string;
  rows: { label: string; detail: string }[];
}) {
  return (
    <div>
      <h3 className="text-xs font-medium">{title}</h3>
      {hint ? <p className="text-xs text-[var(--color-text-muted)]">{hint}</p> : null}
      <ul className="mt-1 text-sm">
        {rows.map((row, i) => (
          <li
            key={`${row.label}-${i}`}
            className="flex justify-between gap-4 border-t border-[var(--color-border)] py-1 first:border-0"
          >
            <span className="truncate">{row.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{row.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A number in a table cell that can be typed over.
 *
 * Saves on Enter or on leaving the box, and only when the value actually
 * changed — a tab through a row of six lines should not post six updates.
 * Escape puts the original back, so a half-typed number can be abandoned
 * without having to remember what was there.
 *
 * Kept as a string the whole way. Quantities and costs are strings throughout
 * this system so they never pass through a float, and a cell that parses to a
 * number to display it would undo that at the last step.
 */
function InlineNumber({
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  // The row re-renders with the saved value after a commit, and with someone
  // else's value if the session is reloaded; either way the box should follow
  // unless it is being typed in right now.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  const commit = () => {
    const next = draft.trim();
    if (next === value.trim()) return;
    if (next === "") {
      setDraft(value);
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(next)) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };

  return (
    <input
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      className="w-20 rounded-md border border-transparent bg-transparent px-2 py-1 text-right tabular-nums outline-none hover:border-[var(--color-border)] focus:border-[var(--color-accent)] disabled:opacity-40"
    />
  );
}
