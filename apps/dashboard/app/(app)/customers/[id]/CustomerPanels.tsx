"use client";

import { useState, useTransition } from "react";
import { setConsentAction } from "../actions";
import { formatMinor } from "@/lib/money";
import type { ConsentState, CustomerHistory } from "@snappos/contracts";

/**
 * Marketing consent, as a thing a person records rather than a switch they
 * flip.
 *
 * Three states, not two: granted, declined, and never asked. The third is the
 * one that matters — a customer nobody has ever asked is not the same as one
 * who said no, even though neither may be sent to, and collapsing them into a
 * single unchecked box is how a shop ends up believing it has a mailing list
 * it never actually earned.
 */
export function ConsentPanel({
  customerId,
  initialConsents,
  hasEmail,
  hasPhone,
}: {
  customerId: string;
  initialConsents: ConsentState[];
  hasEmail: boolean;
  hasPhone: boolean;
}) {
  const [consents, setConsents] = useState(initialConsents);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const record = (channel: "email" | "sms", granted: boolean) => {
    setMessage(null);
    setBusy(channel);
    startTransition(async () => {
      const result = await setConsentAction(customerId, {
        channel,
        granted,
        source: "back_office",
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setBusy(null);
      if (result.ok) {
        setConsents(result.data);
        setNote("");
        setMessage({
          kind: "success",
          text: granted ? "Opt-in recorded." : "Opted out. Nothing further will be sent.",
        });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div>
        <h2 className="text-sm font-medium">Marketing consent</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Nothing is sent to a customer without a recorded opt-in. Silence isn&apos;t consent — record
          what actually happened.
        </p>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      {consents.map((consent) => {
        const reachable = consent.channel === "email" ? hasEmail : hasPhone;
        return (
          <div
            key={consent.channel}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3 first:border-0 first:pt-0"
          >
            <div className="text-sm">
              <span className="font-medium capitalize">{consent.channel}</span>
              <span className="ml-2">
                {consent.never_asked ? (
                  <span className="text-[var(--color-text-muted)]">Never asked</span>
                ) : consent.granted ? (
                  <span className="text-[var(--color-success)]">Opted in</span>
                ) : (
                  <span className="text-[var(--color-error)]">Opted out</span>
                )}
              </span>
              {consent.occurred_at ? (
                <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                  {new Date(consent.occurred_at).toLocaleDateString()}
                  {consent.source ? ` · ${consent.source.replace(/_/g, " ")}` : ""}
                </span>
              ) : null}
              {!reachable ? (
                <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                  (no {consent.channel === "email" ? "email address" : "phone number"} on file)
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              {!consent.granted ? (
                <button
                  type="button"
                  disabled={busy !== null || !reachable}
                  onClick={() => record(consent.channel, true)}
                  title={reachable ? undefined : "Add a contact detail for this channel first"}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
                >
                  {busy === consent.channel ? "Saving..." : "Record opt-in"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => record(consent.channel, false)}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
                >
                  {busy === consent.channel ? "Saving..." : "Opt out"}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <label className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3 text-xs">
        How did they opt in? (required to record an opt-in)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Signed the counter sheet, 15 Sep"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {/* SMS promos to a vape shop's list are a separate problem from consent:
          US carriers block tobacco content on A2P messaging regardless of who
          opted in. Saying so here stops someone collecting SMS consent and
          then wondering why nothing sends. */}
      <p className="text-xs text-[var(--color-text-muted)]">
        SMS opt-in is recorded here, but US carriers block tobacco and vape content on business
        texting whoever consented — texts stay transactional (receipts, order ready) until the shop is
        registered through a specialist. Email is the promotional channel.
      </p>
    </section>
  );
}

/**
 * What this customer is worth and what they actually buy.
 *
 * Every number here nets refunds: a customer who bought four and returned
 * three bought one. That matters most in the most-bought list, which exists
 * to answer "what would they want to hear about" — and a refunded item is the
 * clearest possible signal they would not.
 */
export function HistoryPanel({ history }: { history: CustomerHistory }) {
  if (history.visit_count === 0) {
    return (
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">Purchases</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Nothing bought yet. Sales get attached to a customer when the register looks them up at
          checkout.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="text-sm font-medium">Purchases</h2>

      <div className="flex flex-wrap gap-6">
        <Stat label="Lifetime spend" value={formatMinor(history.lifetime_spend_minor)} />
        <Stat label="Visits" value={String(history.visit_count)} />
        <Stat label="Average ticket" value={formatMinor(history.average_ticket_minor)} />
        <Stat
          label="Last visit"
          value={
            history.days_since_last_visit === null
              ? "—"
              : history.days_since_last_visit === 0
                ? "today"
                : `${history.days_since_last_visit}d ago`
          }
        />
      </div>

      {history.top_products.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs text-[var(--color-text-muted)]">Buys most</h3>
          <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-3 py-1.5 font-normal">Item</th>
                  <th className="px-3 py-1.5 text-right font-normal">Qty</th>
                  <th className="px-3 py-1.5 text-right font-normal">Spent</th>
                  <th className="px-3 py-1.5 font-normal">Last bought</th>
                </tr>
              </thead>
              <tbody>
                {history.top_products.map((item) => (
                  <tr key={`${item.product_id}-${item.variant_name ?? ""}`} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-1.5">
                      {item.product_name}
                      {item.variant_name ? ` | ${item.variant_name}` : ""}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{Number(item.quantity)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatMinor(item.gross_minor)}</td>
                    <td className="px-3 py-1.5 text-[var(--color-text-muted)]">
                      {item.last_bought_at ? new Date(item.last_bought_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {history.recent_sales.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs text-[var(--color-text-muted)]">Recent visits</h3>
          <ul className="space-y-1 text-sm">
            {history.recent_sales.map((sale) => (
              <li key={sale.id} className="flex justify-between gap-4">
                <span className="text-[var(--color-text-muted)]">
                  {new Date(sale.completed_at).toLocaleDateString()} · {sale.receipt_no} ·{" "}
                  {sale.line_count} item{sale.line_count === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums">{formatMinor(sale.total_minor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xl tabular-nums">{value}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}
