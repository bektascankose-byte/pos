"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { formatMinor, minorToMajor } from "@/lib/money";
import type { VariantListing } from "@snappos/contracts";
import { getListingsAction, saveListingAction, type ListingForm } from "./listing-actions";

/**
 * Whether each variant is sold on the website, and on what terms.
 *
 * Listing is only half of it: a listed item appears on the website only while
 * a selling rule allows it. That is said on the panel rather than left to be
 * discovered, because "I ticked the box and it's not on the site" is the first
 * thing anyone would ask.
 */
export function SellOnlinePanel({ productId, storeId }: { productId: string; storeId: string | null }) {
  const [rows, setRows] = useState<VariantListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!storeId) return;
    const result = await getListingsAction(productId, storeId);
    if (result.ok) setRows(result.data);
    else setError(result.error);
  };

  useEffect(() => {
    void load();
  }, [productId, storeId]);

  if (!storeId) {
    return <p className="text-sm text-[var(--color-text-muted)]">Set up a store first.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-[var(--color-text-muted)]">
        <p>
          A listed variant can be ordered on the website for pickup. It shows there only while a{" "}
          <Link href="/website" className="text-[var(--color-accent)]">
            selling rule
          </Link>{" "}
          allows it.
        </p>
        <p className="mt-1">
          <strong className="font-medium text-[var(--color-text)]">Safety stock</strong> is held back for the counter: with
          2 set, the website stops selling while two are still on the shelf.
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {rows === null && !error ? <p className="text-sm text-[var(--color-text-muted)]">Loading…</p> : null}

      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2 font-normal">Variant</th>
                <th className="px-3 py-2 text-right font-normal">On hand</th>
                <th className="px-3 py-2 font-normal">On website</th>
                <th className="px-3 py-2 font-normal">Safety stock</th>
                <th className="px-3 py-2 font-normal">Limit per order</th>
                <th className="px-3 py-2 font-normal">Online price</th>
                <th className="px-3 py-2 text-right font-normal">Can sell</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ListingRow key={row.variant_id} row={row} onSaved={load} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ListingRow({ row, onSaved }: { row: VariantListing; onSaved: () => Promise<void> }) {
  const initial: ListingForm = {
    listed: row.availability !== "hidden",
    safetyStock: trimQuantity(row.safety_stock),
    maxPerOrder: row.max_per_order ? trimQuantity(row.max_per_order) : "",
    onlinePrice: row.online_price_minor ? minorToMajor(row.online_price_minor) : "",
  };
  const [form, setForm] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string } | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const label = row.variant_name ?? "This item";
  const inputClass =
    "w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm tabular-nums";

  return (
    <tr className="border-t border-[var(--color-border)] align-middle">
      <td className="px-3 py-2">
        <div>{label}</div>
        <div className="font-mono text-xs text-[var(--color-text-muted)]">{row.upc}</div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{trimQuantity(row.on_hand)}</td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-2">
          <input
            id={`listed-${row.variant_id}`}
            type="checkbox"
            checked={form.listed}
            onChange={(event) => setForm({ ...form, listed: event.target.checked })}
          />
          <span>{form.listed ? "Pickup" : "Hidden"}</span>
        </label>
      </td>
      <td className="px-3 py-2">
        <input
          id={`safety-${row.variant_id}`}
          aria-label={`Safety stock for ${label}`}
          inputMode="numeric"
          className={inputClass}
          value={form.safetyStock}
          onChange={(event) => setForm({ ...form, safetyStock: event.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <input
          id={`max-${row.variant_id}`}
          aria-label={`Limit per order for ${label}`}
          inputMode="numeric"
          placeholder="No limit"
          className={inputClass}
          value={form.maxPerOrder}
          onChange={(event) => setForm({ ...form, maxPerOrder: event.target.value })}
        />
      </td>
      <td className="px-3 py-2">
        <input
          id={`price-${row.variant_id}`}
          aria-label={`Online price for ${label}`}
          inputMode="decimal"
          placeholder={row.regular_price_minor ? minorToMajor(row.regular_price_minor) : "No price"}
          className={inputClass}
          value={form.onlinePrice}
          onChange={(event) => setForm({ ...form, onlinePrice: event.target.value })}
        />
        {!form.onlinePrice && row.regular_price_minor ? (
          <div className="text-xs text-[var(--color-text-muted)]">Counter price {formatMinor(row.regular_price_minor)}</div>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{form.listed ? trimQuantity(row.sellable) : "—"}</td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          disabled={!dirty || pending}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
          onClick={() => {
            setMessage(null);
            startTransition(async () => {
              const result = await saveListingAction(row.variant_id, form);
              if (!result.ok) {
                setMessage({ kind: "error", text: result.error });
                return;
              }
              await onSaved();
              setMessage({ kind: "saved", text: "Saved" });
            });
          }}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {message ? (
          <div
            className={`mt-1 text-xs ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/** "2.000" reads as a weight. Stock and limits here are whole units. */
function trimQuantity(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
