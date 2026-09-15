"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor } from "@/lib/money";
import { getPriceHistoryAction, getVariantMovementsAction, type PriceHistoryRow } from "../actions";
import { addVariantBarcodeAction, removeVariantBarcodeAction } from "../../items/actions";
import type { LedgerEntry, Variant } from "@snappos/contracts";

/** Reasons that mean stock arrived from a vendor, and reasons that mean it left over the counter. */
const PURCHASE_REASONS = new Set(["receiving", "vendor_return"]);
const SALE_REASONS = new Set(["sale", "refund", "online_order"]);

export function VariantPicker({
  variants,
  selectedId,
  onSelect,
}: {
  variants: Variant[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  // A single-variant product is the common case and needs no picker at all --
  // the tab simply describes the one item.
  if (variants.length < 2) return null;
  return (
    <label className="mb-4 flex items-center gap-2 text-sm">
      Variant
      <select
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.variant_name ?? variant.sku}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Codes for one variant, split by what the code means. "Unit" codes scan as
 * one; carton codes carry a `units` above 1, which is what makes the register
 * add a case instead of a single item.
 */
export function CodesPanel({
  variant,
  mode,
  onChanged,
}: {
  variant: Variant;
  mode: "unit" | "carton";
  onChanged: () => Promise<void>;
}) {
  const [addPending, startAddTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const all = variant.barcodes ?? [];
  const codes = all.filter((code) =>
    mode === "carton" ? Number(code.units) > 1 : Number(code.units) <= 1,
  );

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        {mode === "carton"
          ? "Scan a carton at the register and it rings up this many of the item below."
          : "Every code that scans as a single one of this item — its own barcode, plus any a vendor uses."}
      </p>

      {error ? <p className="mb-2 text-sm text-[var(--color-error)]">{error}</p> : null}

      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="py-2 font-normal">Code</th>
            <th className="py-2 font-normal">Kind</th>
            {mode === "carton" ? <th className="py-2 font-normal">Units per scan</th> : null}
            <th className="py-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {codes.map((code) => (
            <tr key={code.id} className="border-t border-[var(--color-border)]">
              <td className="py-2 font-mono">{code.barcode}</td>
              <td className="py-2">
                {code.kind}
                {code.is_primary ? (
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">primary</span>
                ) : null}
              </td>
              {mode === "carton" ? <td className="py-2 tabular-nums">{Number(code.units)}</td> : null}
              <td className="py-2 text-right">
                {code.is_primary ? null : (
                  <button
                    type="button"
                    disabled={removePending}
                    onClick={() => {
                      setError(null);
                      startRemoveTransition(async () => {
                        const outcome = await removeVariantBarcodeAction(code.id);
                        if (outcome.ok) await onChanged();
                        else setError(outcome.error);
                      });
                    }}
                    className="text-xs text-[var(--color-text-muted)] disabled:opacity-60"
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
          {codes.length === 0 ? (
            <tr className="border-t border-[var(--color-border)]">
              <td colSpan={4} className="py-4 text-center text-[var(--color-text-muted)]">
                {mode === "carton" ? "No carton codes yet." : "No codes on file."}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {showAdd ? (
        <form
          className="mt-4 flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const form = e.currentTarget;
            const formData = new FormData(form);
            startAddTransition(async () => {
              const outcome = await addVariantBarcodeAction(variant.id, formData);
              if (outcome.ok) {
                form.reset();
                setShowAdd(false);
                await onChanged();
              } else {
                setError(outcome.error);
              }
            });
          }}
        >
          <label className="flex w-56 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            {mode === "carton" ? "Carton code" : "Code"}
            <input
              name="barcode"
              autoFocus
              required
              placeholder={mode === "carton" ? "scan the case" : "scan the item"}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex w-32 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Kind
            <select
              name="kind"
              defaultValue={mode === "carton" ? "case" : "upc"}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              {mode === "carton" ? <option value="case">case</option> : null}
              <option value="upc">upc</option>
              <option value="ean">ean</option>
              <option value="itf14">itf14</option>
              <option value="custom">custom</option>
            </select>
          </label>
          {mode === "carton" ? (
            <label className="flex w-32 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Units per scan
              <input
                name="units"
                defaultValue="10"
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          ) : (
            <input type="hidden" name="units" value="1" />
          )}
          <button
            type="submit"
            disabled={addPending}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {addPending ? "Adding..." : "Add code"}
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(false)}
            className="text-sm text-[var(--color-text-muted)] underline"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="mt-4 text-sm text-[var(--color-accent)] underline"
        >
          {mode === "carton" ? "+ Add a carton code" : "+ Add a code"}
        </button>
      )}
    </section>
  );
}

export function PriceHistoryPanel({ variantId }: { variantId: string }) {
  const [rows, setRows] = useState<PriceHistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    getPriceHistoryAction(variantId).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) setRows(outcome.data);
      else setError(outcome.error);
    });
    return () => {
      cancelled = true;
    };
  }, [variantId]);

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;
  if (!rows) return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">This item has never been priced.</p>;
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="px-4 py-2 font-normal">Price</th>
            <th className="px-4 py-2 font-normal">Kind</th>
            <th className="px-4 py-2 font-normal">From</th>
            <th className="px-4 py-2 font-normal">Until</th>
            <th className="px-4 py-2 font-normal">Changed by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2 font-medium">{formatMinor(String(row.price_minor))}</td>
              <td className="px-4 py-2">{row.kind}</td>
              <td className="px-4 py-2">{new Date(row.effective_from).toLocaleDateString()}</td>
              <td className="px-4 py-2">
                {row.effective_to ? (
                  new Date(row.effective_to).toLocaleDateString()
                ) : (
                  <span className="text-[var(--color-success)]">current</span>
                )}
              </td>
              <td className="px-4 py-2 text-[var(--color-text-muted)]">{row.changed_by ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function MovementsPanel({ variantId, mode }: { variantId: string; mode: "purchases" | "sales" }) {
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    getVariantMovementsAction(variantId).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) setRows(outcome.data);
      else setError(outcome.error);
    });
    return () => {
      cancelled = true;
    };
  }, [variantId]);

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;
  if (!rows) return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;

  const reasons = mode === "purchases" ? PURCHASE_REASONS : SALE_REASONS;
  const filtered = rows.filter((row) => reasons.has(row.reason));

  if (filtered.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        {mode === "purchases"
          ? "Nothing received for this item yet."
          : "This item hasn't sold yet."}
      </p>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="text-left text-[var(--color-text-muted)]">
          <tr>
            <th className="px-4 py-2 font-normal">When</th>
            <th className="px-4 py-2 font-normal">Quantity</th>
            {mode === "purchases" ? <th className="px-4 py-2 font-normal">Unit cost</th> : null}
            <th className="px-4 py-2 font-normal">Reason</th>
            <th className="px-4 py-2 font-normal">Reference</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => (
            <tr key={row.id} className="border-t border-[var(--color-border)]">
              <td className="px-4 py-2">{new Date(row.occurred_at).toLocaleString()}</td>
              <td className="px-4 py-2 tabular-nums">{Number(row.delta)}</td>
              {mode === "purchases" ? (
                <td className="px-4 py-2 tabular-nums">
                  {row.unit_cost ? `$${Number(row.unit_cost).toFixed(2)}` : "—"}
                </td>
              ) : null}
              <td className="px-4 py-2">{row.reason.replace(/_/g, " ")}</td>
              <td className="px-4 py-2 text-[var(--color-text-muted)]">
                {row.reference_type === "purchase_order" && row.reference_id ? (
                  <Link
                    href={`/inventory/purchase-orders/${row.reference_id}`}
                    className="text-[var(--color-accent)] underline"
                  >
                    purchase order
                  </Link>
                ) : (
                  (row.note ?? row.reference_type ?? "—").replace(/_/g, " ")
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
