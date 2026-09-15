"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { formatMinor } from "@/lib/money";
import { formatPercent, marginPercent, retailDollars } from "@/lib/margin";
import { bulkUpdateProductsAction, bulkSetPriceAction, addToPriceCategoryAction } from "./actions";
import type { Brand, Category, TaxCategory, PriceCategory } from "@snappos/contracts";

interface SearchRow {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_id: string;
  product_name: string;
  brand_name: string | null;
  price_minor: string | null;
  cost: string | null;
  on_hand: string;
  available: string;
}

export function CatalogListClient({
  initialRows,
  initialQuery,
  storeId,
  brands,
  categories,
  taxCategories,
  priceCategories,
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
  const [searchPending, startSearchTransition] = useTransition();
  const [actionPending, startActionTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Catalog</h1>
        <div className="flex gap-2">
          <Link
            href="/catalog/price-categories"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
          >
            Price categories
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
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="w-8 px-4 py-2"></th>
                <th className="px-4 py-2 font-normal">Product</th>
                <th className="px-4 py-2 font-normal">Brand</th>
                <th className="px-4 py-2 font-normal">SKU</th>
                <th className="px-4 py-2 font-normal">Price</th>
                <th className="px-4 py-2 font-normal">Margin</th>
                <th className="px-4 py-2 font-normal">Available</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.variant_id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <input type="checkbox" name="row_key" value={`${row.product_id}:${row.variant_id}`} />
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/catalog/${row.product_id}`} className="text-[var(--color-accent)]">
                      {row.product_name}
                      {row.variant_name ? ` — ${row.variant_name}` : ""}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{row.brand_name ?? "—"}</td>
                  <td className="px-4 py-2">{row.sku}</td>
                  <td className="px-4 py-2">{row.price_minor !== null ? formatMinor(row.price_minor) : "—"}</td>
                  <td className="px-4 py-2">
                    <MarginCell priceMinor={row.price_minor} cost={row.cost} />
                  </td>
                  <td className="px-4 py-2">{row.available}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                    {query ? `No match for "${query}".` : "No products yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <span className="text-xs text-[var(--color-text-muted)]">Check rows above, then apply a bulk change:</span>
          <label className="flex flex-col gap-1 text-sm">
            Category
            <select
              name="bulk_category_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
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
              name="bulk_brand_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Unchanged</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Tax category
            <select
              name="bulk_tax_category_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
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
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Unchanged</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <button
            type="button"
            disabled={actionPending}
            onClick={() => runBulkAction(bulkUpdateProductsAction)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
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
            disabled={actionPending}
            onClick={() => runBulkAction(bulkSetPriceAction)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            Price selected together
          </button>

          <span className="mx-2 h-8 w-px bg-[var(--color-border)]" />

          <label className="flex flex-col gap-1 text-sm">
            Price category
            <select
              name="target_price_category_id"
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Choose one</option>
              {priceCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? "(unnamed)"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={actionPending}
            onClick={() => runBulkAction(addToPriceCategoryAction)}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60"
          >
            Add selected to category
          </button>
        </div>
      </form>
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
