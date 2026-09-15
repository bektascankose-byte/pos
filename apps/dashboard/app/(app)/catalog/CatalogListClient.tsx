"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor } from "@/lib/money";
import { formatPercent, marginPercent, retailDollars } from "@/lib/margin";
import {
  bulkUpdateProductsAction,
  bulkSetPriceAction,
  addToPriceCategoryAction,
  archiveVariantAction,
} from "./actions";
import { ImportExportBar } from "../_components/ImportExportBar";
import { LookupSelect, type LookupOption } from "./LookupSelect";
import { RowEditor } from "./RowEditor";
import type { SearchRow } from "./types";
import type { Brand, Category, TaxCategory, PriceCategory } from "@snappos/contracts";

export function CatalogListClient({
  initialRows,
  initialQuery,
  storeId,
  brands: initialBrands,
  categories: initialCategories,
  taxCategories,
  priceCategories: initialPriceCategories,
}: {
  initialRows: SearchRow[];
  initialQuery: string;
  storeId: string | null;
  brands: Brand[];
  categories: Category[];
  taxCategories: TaxCategory[];
  priceCategories: PriceCategory[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState(initialQuery);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [editing, setEditing] = useState<SearchRow | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [searchPending, startSearchTransition] = useTransition();
  const [actionPending, startActionTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // Lookups live in state so a "+ Add new" from a dropdown can put the new
  // option into every dropdown at once, without a page reload that would
  // throw away whatever rows are ticked.
  const [categories, setCategories] = useState<LookupOption[]>(
    initialCategories.map((c) => ({ id: c.id, name: c.name })),
  );
  const [brands, setBrands] = useState<LookupOption[]>(initialBrands.map((b) => ({ id: b.id, name: b.name })));
  const [priceGroups, setPriceGroups] = useState<LookupOption[]>(
    initialPriceCategories.map((c) => ({ id: c.id, name: priceGroupLabel(c) })),
  );

  const refreshRows = async (q: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (storeId) params.set("store_id", storeId);
    const res = await fetch(`/api/catalog/search?${params}`);
    const json = await res.json();
    if (!res.ok) {
      setMessage({ kind: "error", text: json.error ?? "Could not load the catalog." });
      return;
    }
    setRows(json.data);
    setSelectedCount(0);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    startSearchTransition(() => refreshRows(query));
  };

  const runBulkAction = (action: (formData: FormData) => Promise<{ ok: boolean; error?: string }>) => {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    startActionTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setMessage({ kind: "success", text: "Saved." });
        await refreshRows(query);
      } else {
        setMessage({ kind: "error", text: result.error ?? "Something went wrong." });
      }
    });
  };

  const archive = (row: SearchRow) => {
    setMessage(null);
    startActionTransition(async () => {
      const result = await archiveVariantAction(row.variant_id);
      if (result.ok) {
        setMessage({
          kind: "success",
          text: `${row.product_name} archived. Past sales and receipts are untouched.`,
        });
        await refreshRows(query);
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const recountSelected = () => {
    if (!formRef.current) return;
    setSelectedCount(new FormData(formRef.current).getAll("row_key").length);
  };

  const toggleAll = (checked: boolean) => {
    if (!formRef.current) return;
    for (const box of formRef.current.querySelectorAll<HTMLInputElement>('input[name="row_key"]')) {
      box.checked = checked;
    }
    recountSelected();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Catalog</h1>
        <div className="flex flex-wrap gap-2">
          <ImportExportBar entity="item" query={query} />
          <Link
            href="/catalog/price-categories"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
          >
            Price groups
          </Link>
          <Link
            href="/catalog/new"
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Add product
          </Link>
        </div>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, SKU, or brand"
          className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={searchPending}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm disabled:opacity-60"
        >
          {searchPending ? "Searching..." : "Search"}
        </button>
      </form>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <form ref={formRef} className="flex flex-col gap-3">
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className="px-3 py-2 font-normal">Product</th>
                <th className="px-3 py-2 font-normal">Brand</th>
                <th className="px-3 py-2 font-normal">Category</th>
                <th className="px-3 py-2 font-normal">SKU</th>
                <th className="px-3 py-2 text-right font-normal">Cost</th>
                <th className="px-3 py-2 text-right font-normal">Price</th>
                <th className="px-3 py-2 text-right font-normal">Margin</th>
                <th className="px-3 py-2 font-normal">Price group</th>
                <th className="px-3 py-2 text-right font-normal">Available</th>
                <th className="px-3 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.variant_id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      name="row_key"
                      value={`${row.product_id}:${row.variant_id}`}
                      onChange={recountSelected}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/catalog/${row.product_id}`} className="text-[var(--color-accent)]">
                      {row.product_name}
                      {row.variant_name ? ` — ${row.variant_name}` : ""}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{row.brand_name ?? "—"}</td>
                  <td className="px-3 py-2">{row.category_name ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.sku}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.cost && Number(row.cost) > 0 ? `$${trimDecimal(row.cost)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.price_minor !== null ? formatMinor(row.price_minor) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <MarginCell priceMinor={row.price_minor} cost={row.cost} />
                  </td>
                  {/*
                    Not `price_group_name ?? "—"`: most groups have no name,
                    so that rendered an item that IS grouped identically to
                    one that isn't — the exact thing this column was added to
                    show. The id decides whether there's a group; the name
                    only decides what to call it.
                  */}
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {row.price_group_id === null ? "—" : (row.price_group_name ?? "Grouped")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(row.available)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        title="Edit this item"
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={actionPending}
                        onClick={() => archive(row)}
                        title="Hide from the catalog, the register and search. Past sales are kept, and it can be restored."
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-error)] disabled:opacity-40"
                      >
                        Archive
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                    {query ? `No match for "${query}".` : "No products yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/*
          Pinned to the bottom of the screen while the list scrolls past it.
          The bar is what the checkboxes are *for*, and having to scroll to the
          end of a few hundred rows to reach it — then back up to see what was
          ticked — was the complaint. `sticky` rather than `fixed` so it still
          sits in the layout and settles at the end of the page instead of
          covering the last row forever.
        */}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
          <span className="text-xs text-[var(--color-text-muted)]">
            {selectedCount > 0
              ? `${selectedCount} selected — apply a bulk change:`
              : "Check rows above, then apply a bulk change:"}
          </span>

          <LookupSelect
            kind="category"
            label="Category"
            name="bulk_category_id"
            options={categories}
            onCreated={(option) => setCategories((prev) => [...prev, option])}
          />
          <LookupSelect
            kind="brand"
            label="Brand"
            name="bulk_brand_id"
            options={brands}
            onCreated={(option) => setBrands((prev) => [...prev, option])}
          />
          <label className="flex flex-col gap-1 text-sm">
            Tax category
            <select
              name="bulk_tax_category_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Unchanged</option>
              {taxCategories.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Status
            <select
              name="bulk_status"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Unchanged</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button
            type="button"
            disabled={actionPending || selectedCount === 0}
            onClick={() => runBulkAction(bulkUpdateProductsAction)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            Apply to selected
          </button>

          <span className="mx-2 h-8 w-px bg-[var(--color-border)]" />

          <label className="flex flex-col gap-1 text-sm">
            Set price
            <input
              name="bulk_price"
              placeholder="24.99"
              className="w-24 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="button"
            disabled={actionPending || selectedCount === 0}
            onClick={() => runBulkAction(bulkSetPriceAction)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
          >
            Price selected together
          </button>

          <span className="mx-2 h-8 w-px bg-[var(--color-border)]" />

          <LookupSelect
            kind="price_group"
            label="Price group"
            name="target_price_category_id"
            options={priceGroups}
            placeholder="Choose one"
            onCreated={(option) => setPriceGroups((prev) => [...prev, option])}
          />
          <button
            type="button"
            disabled={actionPending || selectedCount === 0}
            onClick={() => runBulkAction(addToPriceCategoryAction)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-40"
          >
            Add selected to group
          </button>
        </div>
      </form>

      {editing ? (
        <RowEditor
          row={editing}
          categories={categories}
          brands={brands}
          priceGroups={priceGroups}
          onCategoryCreated={(option) => setCategories((prev) => [...prev, option])}
          onBrandCreated={(option) => setBrands((prev) => [...prev, option])}
          onPriceGroupCreated={(option) => setPriceGroups((prev) => [...prev, option])}
          storeLabel={storeId ? "this store" : "all stores"}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setMessage({ kind: "success", text: "Saved." });
            await refreshRows(query);
          }}
        />
      ) : null}
    </div>
  );
}

/** Margin at a glance, and the one number worth interrupting someone over: selling under cost. */
function MarginCell({ priceMinor, cost }: { priceMinor: string | null; cost: string | null }) {
  const retail = retailDollars(priceMinor);
  const unitCost = cost === null || cost.trim() === "" ? null : Number(cost);
  const margin = marginPercent(retail, unitCost);

  if (margin === null) return <span className="text-[var(--color-text-muted)]">—</span>;
  if (margin < 0) {
    return <span className="font-medium text-[var(--color-error)]">{formatPercent(margin)} ⚠</span>;
  }
  return <span>{formatPercent(margin)}</span>;
}

/** `numeric(14,6)` arrives as "9.850000"; four trailing zeros in a table column are noise. */
function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/**
 * A price group people can tell apart in a dropdown.
 *
 * Most groups have no name, and that isn't an oversight: "Price selected
 * together" forms one implicitly, where the group *is* the fact that those
 * items share a price. Four entries all reading "(unnamed)" are unusable, so
 * an unnamed group is labelled by what actually distinguishes it — the price
 * its members share and how many there are.
 */
function priceGroupLabel(category: PriceCategory): string {
  if (category.name) return category.name;
  const items = `${category.member_count} item${category.member_count === 1 ? "" : "s"}`;
  return category.current_price_minor !== null
    ? `${formatMinor(String(category.current_price_minor))} · ${items}`
    : `Mixed prices · ${items}`;
}
