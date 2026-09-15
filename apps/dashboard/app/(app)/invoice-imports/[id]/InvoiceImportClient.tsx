"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  parseInvoiceAction,
  matchInvoiceAction,
  resolveLineAction,
  ignoreLineAction,
  commitInvoiceAction,
  createProductForLineAction,
  addSecondaryBarcodeAction,
} from "../actions";
import { suggestVariantsAction } from "../../catalog/actions";
import { InvoiceVendorPanel } from "./InvoiceVendorPanel";
import type { InvoiceImport, InvoiceImportLine, Category, Vendor } from "@snappos/contracts";
import type { ActionResult } from "@/lib/action-result";

interface VariantOption {
  variant_id: string;
  product_id: string;
  sku: string;
  variant_name: string | null;
  product_name: string;
}

async function refetchImport(id: string): Promise<InvoiceImport | null> {
  const res = await fetch(`/api/invoice-imports/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export function InvoiceImportClient({
  importId,
  initialImport,
  variants,
  products,
  categories,
  vendors,
}: {
  importId: string;
  initialImport: InvoiceImport;
  variants: VariantOption[];
  products: VariantOption[];
  categories: Category[];
  vendors: Vendor[];
}) {
  const [invoiceImport, setInvoiceImport] = useState(initialImport);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = async () => {
    const fresh = await refetchImport(importId);
    if (fresh) setInvoiceImport(fresh);
  };

  const runPageAction = (action: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setMessage(null);
        await refresh();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const lines = invoiceImport.lines ?? [];
  const editable = invoiceImport.status !== "committed";
  const pendingCount = lines.filter((l) => l.status === "pending").length;
  // A vendor is required by commit itself -- checked here too so the button
  // says why it's disabled instead of failing after the click.
  const canCommit =
    editable &&
    lines.length > 0 &&
    pendingCount === 0 &&
    invoiceImport.status !== "uploaded" &&
    Boolean(invoiceImport.vendor_id);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{invoiceImport.source_filename}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          <span className="uppercase">{invoiceImport.source_format}</span> ·{" "}
          <span className="capitalize">{invoiceImport.status}</span> ·{" "}
          {new Date(invoiceImport.created_at).toLocaleString()}
          {invoiceImport.purchase_order_id ? (
            <>
              {" "}
              ·{" "}
              <Link href={`/inventory/purchase-orders/${invoiceImport.purchase_order_id}`} className="underline">
                view purchase order
              </Link>
            </>
          ) : null}
        </p>
      </div>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}
      {invoiceImport.parse_error ? (
        invoiceImport.status === "failed" ? (
          <p className="text-sm text-[var(--color-error)]">Parse error: {invoiceImport.parse_error}</p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">Note: {invoiceImport.parse_error}</p>
        )
      ) : null}

      <InvoiceVendorPanel
        importId={importId}
        invoiceImport={invoiceImport}
        vendors={vendors}
        editable={editable}
        onChanged={refresh}
      />

      <div className="flex flex-wrap items-center gap-2">
        {invoiceImport.status === "uploaded" || invoiceImport.status === "failed" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => runPageAction(() => parseInvoiceAction(importId))}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            Parse this invoice
          </button>
        ) : null}
        {editable && lines.length > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => runPageAction(() => matchInvoiceAction(importId))}
            className="self-start rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
          >
            Find matches
          </button>
        ) : null}
        {editable && lines.length > 0 ? (
          <button
            type="button"
            disabled={!canCommit || pending}
            onClick={() => runPageAction(() => commitInvoiceAction(importId))}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-40"
            title={
              canCommit
                ? undefined
                : !invoiceImport.vendor_id
                  ? "File this invoice under a vendor first"
                  : `${pendingCount} line(s) still need review`
            }
          >
            Commit — create purchase order &amp; receive stock
          </button>
        ) : null}
      </div>
      {editable && lines.length > 0 && !canCommit ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {pendingCount > 0
            ? `${pendingCount} line(s) still need to be resolved, ignored, or split before this can be committed.`
            : !invoiceImport.vendor_id
              ? "This invoice needs a vendor before it can be committed — use the panel above."
              : null}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Matching checks an exact barcode, then this vendor&apos;s own SKU mapping, then a fuzzy
          match against your catalog, then AI for whatever is still unmatched (if configured on
          this server). A suggestion is never applied automatically — resolve each line below, then
          commit to create the purchase order and receive the stock.
        </p>
      ) : null}

      {lines.length > 0 ? (
        <section className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">Lines</div>
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Raw text</th>
                <th className="px-4 py-2 font-normal">Qty</th>
                <th className="px-4 py-2 font-normal">Unit cost</th>
                <th className="px-4 py-2 font-normal">Suggested match</th>
                <th className="px-4 py-2 font-normal">Review</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <LineRow
                  key={line.id}
                  importId={importId}
                  line={line}
                  variants={variants}
                  products={products}
                  categories={categories}
                  editable={editable}
                  splitChildCount={lines.filter((l) => l.split_from_line_id === line.id).length}
                  onChanged={refresh}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function LineRow({
  importId,
  line,
  variants,
  products,
  categories,
  editable,
  splitChildCount,
  onChanged,
}: {
  importId: string;
  line: InvoiceImportLine;
  variants: VariantOption[];
  products: VariantOption[];
  categories: Category[];
  editable: boolean;
  splitChildCount: number;
  onChanged: () => Promise<void>;
}) {
  const [resolvePending, startResolveTransition] = useTransition();
  const [ignorePending, startIgnoreTransition] = useTransition();
  const [barcodePending, startBarcodeTransition] = useTransition();
  const [createPending, startCreateTransition] = useTransition();
  const [suggestPending, startSuggestTransition] = useTransition();
  const [rowError, setRowError] = useState<string | null>(null);
  const [existingProductId, setExistingProductId] = useState("");
  const [startingPrice, setStartingPrice] = useState("");
  const [variantRows, setVariantRows] = useState<{ id: number; prefillVariantName: string }[]>([
    { id: 0, prefillVariantName: "" },
  ]);
  const nextRowId = useRef(1);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [checkedSuggestions, setCheckedSuggestions] = useState<Set<string>>(new Set());
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const productNameRef = useRef<HTMLInputElement>(null);
  const brandRef = useRef<HTMLInputElement>(null);

  const defaultVariantId = line.resolved_variant_id ?? line.ai_suggested_variant_id ?? "";
  const suggestedName = line.ai_suggested_product_description ?? line.parsed_description ?? "";

  const addVariantRow = (prefillVariantName = "") => {
    setVariantRows((prev) => [...prev, { id: nextRowId.current++, prefillVariantName }]);
  };
  const removeVariantRow = (id: number) => {
    setVariantRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  };

  const handleSuggestVariants = () => {
    setSuggestError(null);
    const productName = existingProductId
      ? (products.find((p) => p.product_id === existingProductId)?.product_name ?? "")
      : (productNameRef.current?.value.trim() ?? "");
    startSuggestTransition(async () => {
      const result = await suggestVariantsAction(productName, brandRef.current?.value);
      if (result.ok) {
        setSuggestions(result.data.variants);
        setCheckedSuggestions(new Set());
      } else {
        setSuggestError(result.error);
      }
    });
  };

  const handleAddCheckedSuggestions = () => {
    setVariantRows((prev) => [
      ...prev,
      ...Array.from(checkedSuggestions, (name) => ({ id: nextRowId.current++, prefillVariantName: name })),
    ]);
    setSuggestions((prev) => prev?.filter((s) => !checkedSuggestions.has(s)) ?? null);
    setCheckedSuggestions(new Set());
  };

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="max-w-xs px-4 py-2 text-xs text-[var(--color-text-muted)]">
        {line.split_from_line_id ? (
          <span className="mb-1 block text-[var(--color-accent)]">↳ split from another line</span>
        ) : null}
        {line.raw_text}
      </td>
      <td className="px-4 py-2 tabular-nums">{line.parsed_quantity ?? "—"}</td>
      <td className="px-4 py-2 tabular-nums">{line.parsed_unit_cost ?? "—"}</td>
      <td className="px-4 py-2">
        {line.ai_suggested_product_name ? (
          <>
            {line.ai_suggested_product_name}
            {line.ai_suggested_variant_name ? ` | ${line.ai_suggested_variant_name}` : ""}
            <span className="block text-xs text-[var(--color-text-muted)]">
              {line.ai_confidence !== null ? `${Math.round(line.ai_confidence * 100)}% confidence` : ""}
            </span>
          </>
        ) : (line.ai_suggested_brand ?? line.ai_suggested_category ?? line.ai_suggested_product_description) ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            no catalog match — AI suggests:{" "}
            {[line.ai_suggested_brand, line.ai_suggested_category, line.ai_suggested_product_description]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <span className="text-[var(--color-text-muted)]">no match yet</span>
        )}
        {line.is_ambiguous_multi_item ? (
          <span className="mt-1 block text-xs font-medium text-[var(--color-error)]">
            ⚠ looks like more than one item
          </span>
        ) : null}
      </td>
      <td className="min-w-[16rem] px-4 py-2">
        <p className="mb-1 text-xs capitalize">
          {line.status}
          {(line.status === "matched" || line.status === "new_product") && line.resolved_product_name ? (
            <span className="block text-[var(--color-text-muted)]">
              → {line.resolved_product_name}
              {line.resolved_variant_name ? ` | ${line.resolved_variant_name}` : ""}
            </span>
          ) : null}
          {line.status === "split" ? (
            <span className="block text-[var(--color-text-muted)]">into {splitChildCount} line(s)</span>
          ) : null}
        </p>

        {rowError ? <p className="mb-2 text-xs text-[var(--color-error)]">{rowError}</p> : null}

        {editable && line.status !== "split" ? (
          <div className="flex w-[30rem] max-w-full flex-col gap-3">
            {line.ai_suggested_variant_id ? (
              <ResolveForm
                importId={importId}
                line={line}
                variants={variants}
                defaultVariantId={defaultVariantId}
                pending={resolvePending}
                startTransition={startResolveTransition}
                setRowError={setRowError}
                onChanged={onChanged}
              />
            ) : (
              <>
                <div className="rounded-md border border-[var(--color-border)] p-3">
                  <p className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
                    Create or attach a product
                  </p>
                  <form
                    // Remounts (re-baselining every defaultValue below)
                    // whenever THIS line's own AI suggestion changes -- e.g.
                    // right after "Find matches" fills in a description/brand
                    // that wasn't there when this form first mounted.
                    // `defaultValue` only applies at mount time, so without
                    // this key an already-mounted input would keep showing
                    // its stale initial value forever. State declared on
                    // `LineRow` itself (existingProductId, variantRows,
                    // startingPrice) lives outside this remount boundary and
                    // survives it -- only the uncontrolled field values reset.
                    key={`${suggestedName}|${line.ai_suggested_brand ?? ""}`}
                    className="flex flex-col gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setRowError(null);
                      const formData = new FormData(e.currentTarget);
                      const rowCount = variantRows.length;
                      startCreateTransition(async () => {
                        const result = await createProductForLineAction(importId, line.id, formData, rowCount);
                        if (result.ok) {
                          setVariantRows([{ id: 0, prefillVariantName: "" }]);
                          nextRowId.current = 1;
                          setSuggestions(null);
                          setExistingProductId("");
                          setStartingPrice("");
                          await onChanged();
                        } else {
                          setRowError(result.error);
                        }
                      });
                    }}
                  >
                    <label className="flex flex-col gap-1 text-xs">
                      Attach to an existing product instead (optional)
                      <select
                        name="existing_product_id"
                        value={existingProductId}
                        onChange={(e) => setExistingProductId(e.target.value)}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                      >
                        <option value="">— new product —</option>
                        {products.map((p) => (
                          <option key={p.product_id} value={p.product_id}>
                            {p.product_name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {!existingProductId ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="w-40">
                          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                            Product name
                            <input
                              ref={productNameRef}
                              name="product_name"
                              defaultValue={suggestedName}
                              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                            />
                          </label>
                        </div>
                        <div className="w-32">
                          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                            Brand
                            <input
                              ref={brandRef}
                              name="brand_name"
                              defaultValue={line.ai_suggested_brand ?? ""}
                              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                            />
                          </label>
                        </div>
                        <div className="w-32">
                          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                            Category
                            <select
                              name="category_id"
                              defaultValue=""
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
                        </div>
                        <div className="w-28">
                          <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                            Starting price
                            <input
                              name="starting_price"
                              placeholder="24.99"
                              value={startingPrice}
                              onChange={(e) => setStartingPrice(e.target.value)}
                              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <button
                        type="button"
                        disabled={suggestPending}
                        onClick={handleSuggestVariants}
                        className="text-xs text-[var(--color-accent)] underline disabled:opacity-60"
                      >
                        {suggestPending ? "Searching..." : "✨ Suggest variants with AI"}
                      </button>
                      {suggestError ? <p className="mt-1 text-xs text-[var(--color-error)]">{suggestError}</p> : null}
                      {suggestions && suggestions.length > 0 ? (
                        <div className="mt-2 flex flex-col gap-2 rounded-md border border-dashed border-[var(--color-border)] p-2">
                          <div className="flex flex-wrap gap-2">
                            {suggestions.map((name) => (
                              <label
                                key={name}
                                className="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-1 text-xs"
                              >
                                <input
                                  type="checkbox"
                                  checked={checkedSuggestions.has(name)}
                                  onChange={(e) => {
                                    setCheckedSuggestions((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(name);
                                      else next.delete(name);
                                      return next;
                                    });
                                  }}
                                />
                                {name}
                              </label>
                            ))}
                          </div>
                          <button
                            type="button"
                            disabled={checkedSuggestions.size === 0}
                            onClick={handleAddCheckedSuggestions}
                            className="self-start rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-40"
                          >
                            Add checked as variants
                          </button>
                        </div>
                      ) : suggestions ? (
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          No known variants found — add rows manually below.
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-2">
                      {variantRows.map((row, i) => (
                        <div
                          key={row.id}
                          className="flex flex-wrap items-end gap-2 border-l-2 border-[var(--color-border)] pl-3"
                        >
                          <div className="w-32">
                            <MiniField label="SKU / UPC" name={`sku_${i}`} required={i === 0} />
                          </div>
                          <div className="w-32">
                            <MiniField
                              label={i === 0 ? "Variant name (blank if none)" : "Variant name"}
                              name={`variant_name_${i}`}
                              defaultValue={row.prefillVariantName}
                            />
                          </div>
                          <div className="w-24">
                            <MiniField
                              label="Price"
                              name={`price_${i}`}
                              placeholder={startingPrice || "same as above"}
                            />
                          </div>
                          {variantRows.length > 1 ? (
                            <button
                              type="button"
                              onClick={() => removeVariantRow(row.id)}
                              title="Remove this variant"
                              className="mb-1.5 text-xs text-[var(--color-text-muted)]"
                            >
                              ✕
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => addVariantRow()}
                      className="self-start text-xs text-[var(--color-accent)] underline"
                    >
                      + Add another variant
                    </button>

                    <button
                      type="submit"
                      disabled={createPending}
                      className="mt-1 self-start rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
                    >
                      {createPending ? "Saving..." : "Create / attach product"}
                    </button>
                  </form>
                </div>

                <details className="rounded-md border border-[var(--color-border)] p-2 text-xs">
                  <summary className="cursor-pointer text-[var(--color-text-muted)]">
                    Already have this in your catalog? Link it directly
                  </summary>
                  <div className="mt-2">
                    <ResolveForm
                      importId={importId}
                      line={line}
                      variants={variants}
                      defaultVariantId={defaultVariantId}
                      pending={resolvePending}
                      startTransition={startResolveTransition}
                      setRowError={setRowError}
                      onChanged={onChanged}
                    />
                  </div>
                </details>
              </>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                disabled={ignorePending}
                onClick={() => {
                  setRowError(null);
                  startIgnoreTransition(async () => {
                    const result = await ignoreLineAction(importId, line.id);
                    if (result.ok) await onChanged();
                    else setRowError(result.error);
                  });
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-60"
              >
                {ignorePending ? "Ignoring..." : "Ignore"}
              </button>
              {line.ai_suggested_variant_id && line.parsed_vendor_sku ? (
                <button
                  type="button"
                  disabled={barcodePending}
                  onClick={() => {
                    setRowError(null);
                    startBarcodeTransition(async () => {
                      const result = await addSecondaryBarcodeAction(importId, line.id);
                      if (result.ok) await onChanged();
                      else setRowError(result.error);
                    });
                  }}
                  title={`Record ${line.parsed_vendor_sku} as another valid code for ${line.ai_suggested_product_name ?? "this variant"}`}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-60"
                >
                  {barcodePending ? "Adding..." : "Also known by this code"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function ResolveForm({
  importId,
  line,
  variants,
  defaultVariantId,
  pending,
  startTransition,
  setRowError,
  onChanged,
}: {
  importId: string;
  line: InvoiceImportLine;
  variants: VariantOption[];
  defaultVariantId: string;
  pending: boolean;
  startTransition: (callback: () => Promise<void>) => void;
  setRowError: (error: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        setRowError(null);
        const formData = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await resolveLineAction(importId, line.id, formData);
          if (result.ok) await onChanged();
          else setRowError(result.error);
        });
      }}
    >
      <select
        key={defaultVariantId}
        name="variant_id"
        defaultValue={defaultVariantId}
        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
      >
        <option value="">— pick a variant —</option>
        {variants.map((v) => (
          <option key={v.variant_id} value={v.variant_id}>
            {v.product_name}
            {v.variant_name ? ` | ${v.variant_name}` : ""} ({v.sku})
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
        <input type="checkbox" name="is_new_product" />
        just created this variant for this line
      </label>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
      >
        {pending ? "Resolving..." : "Resolve"}
      </button>
    </form>
  );
}

function MiniField({
  label,
  name,
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
