"use client";

import { useState, useTransition } from "react";
import { quickEditRowAction } from "./actions";
import { Modal } from "../_components/Modal";
import type { SearchRow } from "./types";
import type { Brand, Category } from "@snappos/contracts";

/**
 * Editing one item without leaving the list.
 *
 * Covers the fields someone actually corrects while looking at a list — the
 * name, what it's called, its code, what it costs and what it sells for. Rarer
 * things (compliance, case costing, barcodes, price history) stay on the
 * item's own page, which the title links to; putting all of it here would make
 * the common edit slower to do.
 *
 * Leaving a field alone leaves it alone: blank means unchanged, matching every
 * other edit form in the back office.
 */
export function RowEditor({
  row,
  categories,
  brands,
  storeLabel,
  onClose,
  onSaved,
}: {
  row: SearchRow;
  categories: Category[];
  brands: Brand[];
  storeLabel: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${row.product_name}${row.variant_name ? ` — ${row.variant_name}` : ""}`}
      description="Leave a field blank to keep what's there."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const result = await quickEditRowAction(row.product_id, row.variant_id, formData);
            if (result.ok) onSaved();
            else setError(result.error);
          });
        }}
      >
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        <Field label="Product name" name="product_name" defaultValue={row.product_name} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Variant" name="variant_name" defaultValue={row.variant_name ?? ""} />
          <Field label="SKU" name="sku" defaultValue={row.sku} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="PLU" name="plu" defaultValue={row.plu ?? ""} />
          <Field label="Unit cost ($)" name="cost" defaultValue={row.cost ? trimDecimal(row.cost) : ""} />
        </div>
        <Field
          label={`Price ($) — ${storeLabel}`}
          name="price"
          defaultValue={row.price_minor ? minorToMajor(row.price_minor) : ""}
          hint="Changing this is recorded in the item's price history."
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Category
            <select
              name="category_id"
              defaultValue={row.category_id ?? ""}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <option value="">Unchanged</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Brand
            <select
              name="brand_id"
              defaultValue={row.brand_id ?? ""}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <option value="">Unchanged</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-1 flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      {hint ? <span className="text-xs text-[var(--color-text-muted)]">{hint}</span> : null}
    </label>
  );
}

function minorToMajor(minor: string): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/** `numeric(14,6)` arrives as "9.850000"; nobody wants to edit four trailing zeros. */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
