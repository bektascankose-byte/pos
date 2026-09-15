"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor, minorToMajor } from "@/lib/money";
import { createProductAction } from "../catalog/actions";
import {
  lookupItemAction,
  getItemAction,
  addVariantBarcodeAction,
  removeVariantBarcodeAction,
  type ItemDetail,
  type LookupResult,
  type SearchHit,
  type StockByVariant,
} from "./actions";
import type { Brand, Category, ReferenceProduct, Variant } from "@snappos/contracts";

export function ItemLookupClient({
  brands,
  categories,
  storeId,
}: {
  brands: Brand[];
  categories: Category[];
  storeId: string | null;
}) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [searchedFor, setSearchedFor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  // A scanner fires the next code straight at whatever has focus, so the box
  // takes it back as soon as a lookup settles -- otherwise the second scan of
  // a stock-check session goes nowhere.
  const refocus = () => {
    scanRef.current?.focus();
    scanRef.current?.select();
  };

  const runLookup = (value: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await lookupItemAction(value, storeId);
      if (outcome.ok) {
        setResult(outcome.data);
        setSearchedFor(value.trim());
      } else {
        setResult(null);
        setError(outcome.error);
      }
      refocus();
    });
  };

  const showProduct = (productId: string) => {
    setError(null);
    startTransition(async () => {
      const outcome = await getItemAction(productId, storeId);
      if (outcome.ok) {
        setResult({ kind: "item", item: outcome.data, matchedVariantId: "", matchedKind: null, matchedUnits: null });
      } else {
        setError(outcome.error);
      }
    });
  };

  const reloadItem = async (productId: string) => {
    const outcome = await getItemAction(productId, storeId);
    if (outcome.ok) {
      // The "you scanned the carton code" note describes the scan that opened
      // this card, which stops being true the moment its codes change -- not
      // least when the code it's describing is the one just removed.
      setResult((prev) =>
        prev && prev.kind === "item"
          ? { ...prev, item: outcome.data, matchedVariantId: "", matchedKind: null, matchedUnits: null }
          : prev,
      );
    } else {
      setError(outcome.error);
    }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Item lookup</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Scan anything — a unit barcode or a carton code — to see what it is. Nothing on file
          for it? Add it right here.
        </p>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          runLookup(code);
        }}
      >
        <input
          ref={scanRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          // Handled explicitly rather than left to the form's implicit
          // submission: a scanner ends its code with a keystroke, and that is
          // the whole interaction on this page, so it shouldn't depend on
          // which key the scanner is configured to send it as.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runLookup(code);
            }
          }}
          placeholder="Scan or type a code"
          className="w-80 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Looking up..." : "Look up"}
        </button>
      </form>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      {result?.kind === "item" ? (
        <ItemCard
          item={result.item}
          matchedVariantId={result.matchedVariantId}
          matchedKind={result.matchedKind}
          matchedUnits={result.matchedUnits}
          onChanged={() => reloadItem(result.item.product.id)}
        />
      ) : null}

      {result?.kind === "matches" ? (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm">
            No code matched “{searchedFor}” exactly — these names look close:
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {result.hits.map((hit) => (
              <li key={hit.variant_id}>
                <button
                  type="button"
                  onClick={() => showProduct(hit.product_id)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-[var(--color-bg)]"
                >
                  <span>
                    {hit.product_name}
                    {hit.variant_name ? ` | ${hit.variant_name}` : ""}
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      {hit.brand_name ? `${hit.brand_name} · ` : ""}UPC {hit.sku}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {hit.price_minor ? formatMinor(String(hit.price_minor)) : "not priced"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result?.kind === "none" ? (
        <CreateItemForm
          code={searchedFor}
          reference={result.reference}
          brands={brands}
          categories={categories}
          storeId={storeId}
          onCreated={(productId) => showProduct(productId)}
        />
      ) : null}
    </div>
  );
}

function ItemCard({
  item,
  matchedVariantId,
  matchedKind,
  matchedUnits,
  onChanged,
}: {
  item: ItemDetail;
  matchedVariantId: string;
  matchedKind: string | null;
  matchedUnits: string | null;
  onChanged: () => Promise<void>;
}) {
  const { product, stock } = item;
  const scannedUnits = Number(matchedUnits ?? "1");
  const variants = product.variants ?? [];

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{product.name}</h2>
          <p className="text-xs text-[var(--color-text-muted)]">
            {product.status}
            {product.compliance ? " · age-restricted" : ""}
          </p>
        </div>
        <Link href={`/catalog/${product.id}`} className="text-xs text-[var(--color-accent)] underline">
          Open in catalog
        </Link>
      </div>

      {scannedUnits > 1 ? (
        <p className="rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs">
          That was a <span className="font-medium">{matchedKind ?? "case"}</span> code — scanning it at the
          register rings up <span className="font-medium">{scannedUnits}</span> of this item.
        </p>
      ) : null}

      {variants.map((variant) => (
        <VariantPanel
          key={variant.id}
          variant={variant}
          stock={stock}
          highlighted={variant.id === matchedVariantId}
          onChanged={onChanged}
        />
      ))}
    </section>
  );
}

function VariantPanel({
  variant,
  stock,
  highlighted,
  onChanged,
}: {
  variant: Variant;
  stock: StockByVariant;
  highlighted: boolean;
  onChanged: () => Promise<void>;
}) {
  const level = stock[variant.id];
  const [addPending, startAddTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const [panelError, setPanelError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const barcodes = variant.barcodes ?? [];

  return (
    <div
      className={`rounded-md border p-3 ${
        highlighted ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">
          {variant.variant_name ?? "Single item"}
          <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">UPC {variant.sku}</span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {variant.price_minor !== undefined && variant.price_minor !== null
            ? formatMinor(String(variant.price_minor))
            : "not priced"}
          {level ? ` · ${Number(level.on_hand)} on hand` : " · no stock recorded"}
        </div>
      </div>

      {panelError ? <p className="mt-2 text-xs text-[var(--color-error)]">{panelError}</p> : null}

      <div className="mt-3">
        <p className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">Codes</p>
        <ul className="flex flex-col gap-1">
          {barcodes.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono">{b.barcode}</span>
              <span className="text-[var(--color-text-muted)]">{b.kind}</span>
              {Number(b.units) > 1 ? (
                <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5">
                  = {Number(b.units)} units
                </span>
              ) : null}
              {b.is_primary ? <span className="text-[var(--color-text-muted)]">primary</span> : null}
              {!b.is_primary ? (
                <button
                  type="button"
                  disabled={removePending}
                  title="Remove this code"
                  onClick={() => {
                    setPanelError(null);
                    startRemoveTransition(async () => {
                      const outcome = await removeVariantBarcodeAction(b.id);
                      if (outcome.ok) await onChanged();
                      else setPanelError(outcome.error);
                    });
                  }}
                  className="text-[var(--color-text-muted)] disabled:opacity-60"
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
          {barcodes.length === 0 ? (
            <li className="text-xs text-[var(--color-text-muted)]">No codes on file.</li>
          ) : null}
        </ul>
      </div>

      {showAdd ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-l-2 border-[var(--color-border)] pl-3"
          onSubmit={(e) => {
            e.preventDefault();
            setPanelError(null);
            const form = e.currentTarget;
            const formData = new FormData(form);
            startAddTransition(async () => {
              const outcome = await addVariantBarcodeAction(variant.id, formData);
              if (outcome.ok) {
                form.reset();
                setShowAdd(false);
                await onChanged();
              } else {
                setPanelError(outcome.error);
              }
            });
          }}
        >
          <label className="flex w-48 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Carton / alternate code
            <input
              name="barcode"
              autoFocus
              required
              placeholder="scan the carton"
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex w-28 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Kind
            <select
              name="kind"
              defaultValue="case"
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="case">case</option>
              <option value="upc">upc</option>
              <option value="ean">ean</option>
              <option value="itf14">itf14</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label className="flex w-32 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Units per scan
            <input
              name="units"
              defaultValue="10"
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            disabled={addPending}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {addPending ? "Adding..." : "Add code"}
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(false)}
            className="text-xs text-[var(--color-text-muted)] underline"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="mt-2 text-xs text-[var(--color-accent)] underline"
        >
          + Add a carton or alternate code
        </button>
      )}
    </div>
  );
}

function CreateItemForm({
  code,
  reference,
  brands,
  categories,
  storeId,
  onCreated,
}: {
  code: string;
  reference: ReferenceProduct | null;
  brands: Brand[];
  categories: Category[];
  storeId: string | null;
  onCreated: (productId: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  // The old system's department is matched to a category by name. Only an
  // exact name match counts: a near miss silently filing an item under the
  // wrong category is worse than leaving the field blank for a human.
  const matchedCategory = reference?.department
    ? categories.find((c) => c.name.toLowerCase() === reference.department!.toLowerCase())
    : undefined;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="text-sm font-medium">
        {reference ? "Not in your catalog yet" : "Nothing on file for"}{" "}
        <span className="font-mono">{code}</span> — add it
      </h2>

      {reference ? (
        <p className="mt-2 rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          Filled in from your Modisoft item file
          {reference.department ? ` (${reference.department})` : ""}
          {reference.source_quantity && Number(reference.source_quantity) !== 0
            ? ` — it last showed ${Number(reference.source_quantity)} on hand there`
            : ""}
          . Check it before saving; nothing has been created yet.
        </p>
      ) : null}

      {formError ? <p className="mt-2 text-xs text-[var(--color-error)]">{formError}</p> : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setFormError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const outcome = await createProductAction(formData);
            if (outcome.ok) onCreated(outcome.data.id);
            else setFormError(outcome.error);
          });
        }}
      >
        <input type="hidden" name="store_id" value={storeId ?? ""} />
        {/* This business treats a SKU and a UPC as the same number, so the code
            that just missed becomes both -- scanning it again finds this item. */}
        <input type="hidden" name="sku" value={code} />
        <input type="hidden" name="barcode" value={code} />
        <Field
          label="Name"
          name="name"
          required
          className="w-64"
          defaultValue={reference?.description ?? ""}
        />
        <Field
          label="Price"
          name="price"
          placeholder="9.99"
          className="w-24"
          defaultValue={reference?.retail_minor ? minorToMajor(String(reference.retail_minor)) : ""}
        />
        <Field
          label="Cost"
          name="cost"
          placeholder="0"
          className="w-24"
          defaultValue={reference?.cost ? trimCost(reference.cost) : ""}
        />
        <label className="flex w-40 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Brand
          <select
            name="brand_id"
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">None</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-40 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Category
          <select
            name="category_id"
            key={matchedCategory?.id ?? ""}
            defaultValue={matchedCategory?.id ?? ""}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Creating..." : "Create item"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  className,
  defaultValue,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  defaultValue?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-[var(--color-text-muted)] ${className ?? ""}`}>
      {label}
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        // Keyed on the value so a second scan re-fills the box: `defaultValue`
        // is only read when the input first mounts, and without this the form
        // would keep showing the first item's details for every later scan.
        key={defaultValue ?? ""}
        defaultValue={defaultValue ?? ""}
        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

/**
 * Cost is `numeric(14,6)`, so it arrives as "3.500000". Trailing zeroes are
 * exact but unreadable in a form field; the value is trimmed as text, never
 * by parsing it as a float.
 */
function trimCost(cost: string): string {
  return cost.includes(".") ? cost.replace(/0+$/, "").replace(/\.$/, "") : cost;
}
