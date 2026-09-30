"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor, parseMajorToMinor } from "@/lib/money";
import {
  getPriceHistoryAction,
  getVariantMovementsAction,
  setPriceAction,
  updateVariantAction,
  type PriceHistoryRow,
} from "../actions";
import { addVariantBarcodeAction, removeVariantBarcodeAction } from "../../items/actions";
import { applyToAllFlavorsAction } from "./pricing-actions";
import {
  formatDollars,
  formatPercent,
  marginSummary,
  retailForMargin,
} from "@/lib/margin";
import type { LedgerEntry, Variant } from "@snappos/contracts";

/** Reasons that mean stock arrived from a vendor, and reasons that mean it left over the counter. */
const PURCHASE_REASONS = new Set(["receiving", "vendor_return"]);
const SALE_REASONS = new Set(["sale", "refund", "online_order"]);

/** The picker's value for "every flavor at once", which no variant id can collide with. */
export const ALL_FLAVORS = "__all__";

export function VariantPicker({
  variants,
  selectedId,
  onSelect,
  allOption,
}: {
  variants: Variant[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** When given, a first choice that stands for every flavor, labelled with this. */
  allOption?: string;
}) {
  // A single-variant product is the common case and needs no picker at all --
  // the tab simply describes the one item.
  if (variants.length < 2) return null;
  // A to Z, the order the Variants tab lists them in.
  const ordered = [...variants].sort((a, b) =>
    (a.variant_name ?? a.sku).localeCompare(b.variant_name ?? b.sku, "en", { sensitivity: "base", numeric: true }),
  );
  return (
    <label className="mb-4 flex items-center gap-2 text-sm">
      Variant
      <select
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        {allOption ? <option value={ALL_FLAVORS}>{allOption}</option> : null}
        {ordered.map((variant) => (
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

/**
 * What a case costs, what a unit therefore costs, and what that leaves as
 * margin -- recalculated as it's typed, so the arithmetic an owner would
 * otherwise do on the invoice with a calculator happens on screen instead.
 *
 * Cost and price are saved separately on purpose: a price change is its own
 * event with its own history (`setVariantPrice`), while the case fields are
 * ordinary columns on the variant.
 */
export function PricingPanel({
  productId,
  storeId,
  variant,
  onVariantSaved,
  onPriceSaved,
}: {
  productId: string;
  storeId: string | null;
  variant: Variant;
  onVariantSaved: (updated: Variant) => void;
  onPriceSaved: (priceMinor: string) => void;
}) {
  const [caseCost, setCaseCost] = useState(variant.case_cost ?? "");
  const [caseDiscount, setCaseDiscount] = useState(variant.case_discount ?? "0");
  const [caseRebate, setCaseRebate] = useState(variant.case_rebate ?? "0");
  const [unitsPerCase, setUnitsPerCase] = useState(String(variant.case_quantity));
  // 50% unless this flavor has its own: the shop's usual target, filled in so
  // the suggested price shows straight away. Change it here if this one differs.
  const [defaultMargin, setDefaultMargin] = useState(trimDecimal(variant.default_margin) || DEFAULT_MARGIN);
  const [newPrice, setNewPrice] = useState("");
  const [costPending, startCostTransition] = useTransition();
  const [pricePending, startPriceTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const priceMinor =
    variant.price_minor === undefined || variant.price_minor === null
      ? null
      : String(variant.price_minor);

  const summary = marginSummary({
    caseCost,
    caseDiscount,
    caseRebate,
    unitsPerCase,
    unitCost: variant.cost,
    priceMinor,
  });
  const suggested = retailForMargin(summary.unitCost, defaultMargin);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {message ? <p className="text-sm text-[var(--color-text-muted)]">{message}</p> : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          const formData = new FormData(e.currentTarget);
          startCostTransition(async () => {
            const outcome = await updateVariantAction(productId, variant.id, formData);
            if (outcome.ok) {
              onVariantSaved(outcome.data);
              setMessage("Saved.");
            } else {
              setMessage(outcome.error);
            }
          });
        }}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MoneyField label="Units / case" name="case_quantity" value={unitsPerCase} onChange={setUnitsPerCase} />
          <MoneyField label="Case cost" name="case_cost" value={caseCost} onChange={setCaseCost} placeholder="40.00" />
          <MoneyField label="Case discount" name="case_discount" value={caseDiscount} onChange={setCaseDiscount} />
          <MoneyField label="Case rebate" name="case_rebate" value={caseRebate} onChange={setCaseRebate} />
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-md bg-[var(--color-bg)] p-3 text-sm sm:grid-cols-4">
          <Readout
            label="Cost / unit"
            value={formatDollars(summary.unitCost)}
            note={summary.isDerived ? "from the case" : "entered directly"}
          />
          <Readout label="Unit retail" value={formatDollars(summary.retail)} />
          <Readout label="Margin" value={formatPercent(summary.margin)} />
          <Readout label="After rebate" value={formatPercent(summary.marginAfterRebate)} />
        </div>

        {summary.belowCost ? (
          <p className="text-sm font-medium text-[var(--color-error)]">
            ⚠ This is selling below what it costs.
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-4">
          <MoneyField
            label="Default margin %"
            name="default_margin"
            value={defaultMargin}
            onChange={setDefaultMargin}
            placeholder="32.5"
          />
          {suggested !== null ? (
            <p className="pb-2 text-sm text-[var(--color-text-muted)]">
              At that margin this would sell for{" "}
              <button
                type="button"
                onClick={() => setNewPrice(suggested.toFixed(2))}
                className="font-medium text-[var(--color-accent)] underline"
              >
                {formatDollars(suggested)}
              </button>
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={costPending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {costPending ? "Saving..." : "Save costs"}
        </button>
      </form>

      <form
        className="flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          const form = e.currentTarget;
          const formData = new FormData(form);
          startPriceTransition(async () => {
            const outcome = await setPriceAction(productId, variant.id, storeId, formData);
            if (outcome.ok) {
              onPriceSaved(outcome.data.price_minor);
              setNewPrice("");
              setMessage("Price updated.");
            } else {
              setMessage(outcome.error);
            }
          });
        }}
      >
        <MoneyField
          label="New retail price"
          name="price"
          value={newPrice}
          onChange={setNewPrice}
          placeholder="24.99"
        />
        <button
          type="submit"
          disabled={pricePending}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {pricePending ? "Updating..." : "Update price"}
        </button>
      </form>
    </section>
  );
}

/** The margin target a flavor starts with when it has none of its own. */
const DEFAULT_MARGIN = "50";

/** "40.000000" as "40", "0.500000" as "0.5": how a person would type it. */
function trimDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** The value every flavor shares, or null when they differ. Compared as numbers, so "40" and "40.000000" agree. */
function shared(values: (string | number | null | undefined)[]): string | null {
  const seen = new Set(values.map((value) => trimDecimal(value === undefined || value === null ? null : String(value))));
  return seen.size === 1 ? [...seen][0]! : null;
}

/**
 * Cost & Margin for every flavor at once.
 *
 * Flavors of one line nearly always share a case cost and a shelf price, and
 * setting fourteen of them one by one is how a price gets missed. The boxes
 * start with what every flavor already has in common and say "varies" where
 * they differ. Only what is changed is applied, so a box left as it was, or
 * left blank, keeps each flavor's own value.
 */
export function AllFlavorsPricingPanel({
  productId,
  storeId,
  variants,
  onApplied,
}: {
  productId: string;
  storeId: string | null;
  variants: Variant[];
  onApplied: () => Promise<void>;
}) {
  // What every flavor has on file now, "" where they differ or have nothing.
  // A box is sent only when it no longer reads this.
  const initial = {
    case_quantity: shared(variants.map((v) => v.case_quantity)) ?? "",
    case_cost: shared(variants.map((v) => v.case_cost)) ?? "",
    case_discount: shared(variants.map((v) => v.case_discount)) ?? "",
    case_rebate: shared(variants.map((v) => v.case_rebate)) ?? "",
    default_margin: shared(variants.map((v) => v.default_margin)) ?? "",
  };
  // The margin box starts at 50% when no flavor has one yet, and that 50% is
  // saved with the rest when you apply. Where flavors already differ it
  // starts empty, so applying cannot flatten margins nobody touched.
  const noMarginYet = variants.every((v) => !trimDecimal(v.default_margin));
  const [values, setValues] = useState({ ...initial, default_margin: noMarginYet ? DEFAULT_MARGIN : initial.default_margin });
  const [newPrice, setNewPrice] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const currentPrice = shared(variants.map((v) => (v.price_minor == null ? null : String(v.price_minor))));
  const sharedCost = shared(variants.map((v) => v.cost));
  const set = (key: keyof typeof initial) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  const varies = (key: keyof typeof initial) =>
    shared(variants.map((v) => v[key] as string | number | null)) === null ? "varies" : undefined;

  const typedMinor = newPrice.trim() ? parseMajorToMinor(newPrice) : null;
  const summary = marginSummary({
    caseCost: values.case_cost,
    caseDiscount: values.case_discount,
    caseRebate: values.case_rebate,
    unitsPerCase: values.case_quantity,
    unitCost: sharedCost,
    priceMinor: typedMinor ?? currentPrice,
  });
  const suggested = retailForMargin(summary.unitCost, values.default_margin);

  const run = (fields: Parameters<typeof applyToAllFlavorsAction>[2], done: string, afterwards?: () => void) => {
    setMessage(null);
    startTransition(async () => {
      const outcome = await applyToAllFlavorsAction(productId, storeId, fields);
      if (outcome.ok) {
        afterwards?.();
        setMessage(`${done} for all ${outcome.data.updated} flavors.`);
        await onApplied();
      } else {
        setMessage(outcome.error);
      }
    });
  };

  const applyCosts = () => {
    // Only what changed. Re-sending an untouched box would stamp the shared
    // value over nothing, and a box that says "varies" was never a value.
    const changed = Object.fromEntries(
      (Object.keys(initial) as (keyof typeof initial)[])
        .filter((key) => values[key].trim() !== "" && values[key].trim() !== initial[key])
        .map((key) => [key, values[key].trim()]),
    );
    run(changed, "Costs saved");
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p className="text-sm text-[var(--color-text-muted)]">
        What you change here goes to all {variants.length} flavors. A box you leave as it is keeps
        each flavor&apos;s own value.
      </p>
      {message ? <p className="text-sm text-[var(--color-text-muted)]">{message}</p> : null}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          applyCosts();
        }}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MoneyField label="Units / case" name="case_quantity" value={values.case_quantity} onChange={set("case_quantity")} placeholder={varies("case_quantity")} />
          <MoneyField label="Case cost" name="case_cost" value={values.case_cost} onChange={set("case_cost")} placeholder={varies("case_cost") ?? "40.00"} />
          <MoneyField label="Case discount" name="case_discount" value={values.case_discount} onChange={set("case_discount")} placeholder={varies("case_discount")} />
          <MoneyField label="Case rebate" name="case_rebate" value={values.case_rebate} onChange={set("case_rebate")} placeholder={varies("case_rebate")} />
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-md bg-[var(--color-bg)] p-3 text-sm sm:grid-cols-4">
          <Readout
            label="Cost / unit"
            value={formatDollars(summary.unitCost)}
            note={
              summary.isDerived
                ? "from the case"
                : sharedCost === null
                  ? "varies"
                  : summary.unitCost === null
                    ? "not set yet"
                    : "entered directly"
            }
          />
          <Readout
            label="Unit retail"
            value={formatDollars(summary.retail)}
            note={typedMinor === null && currentPrice === null ? "varies by flavor" : undefined}
          />
          <Readout label="Margin" value={formatPercent(summary.margin)} />
          <Readout label="After rebate" value={formatPercent(summary.marginAfterRebate)} />
        </div>

        {summary.belowCost ? (
          <p className="text-sm font-medium text-[var(--color-error)]">⚠ This is selling below what it costs.</p>
        ) : null}

        <div className="flex flex-wrap items-end gap-4">
          <MoneyField label="Default margin %" name="default_margin" value={values.default_margin} onChange={set("default_margin")} placeholder={varies("default_margin")} />
          {suggested !== null ? (
            <p className="pb-2 text-sm text-[var(--color-text-muted)]">
              At that margin they would sell for{" "}
              <button
                type="button"
                onClick={() => setNewPrice(suggested.toFixed(2))}
                className="font-medium text-[var(--color-accent)] underline"
              >
                {formatDollars(suggested)}
              </button>
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Saving..." : `Save costs for all ${variants.length} flavors`}
        </button>
      </form>

      <form
        className="flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          run({ price: newPrice }, "Price updated", () => setNewPrice(""));
        }}
      >
        <MoneyField label="New retail price" name="price" value={newPrice} onChange={setNewPrice} placeholder="24.99" />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {pending ? "Updating..." : `Update price for all ${variants.length} flavors`}
        </button>
      </form>
    </section>
  );
}

function MoneyField({
  label,
  name,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
}) {
  return (
    <label className="flex w-32 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      {label}
      <input
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function Readout({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="text-base font-medium">{value}</div>
      {note ? <div className="text-xs text-[var(--color-text-muted)]">{note}</div> : null}
    </div>
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
