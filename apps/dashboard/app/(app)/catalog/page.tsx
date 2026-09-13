import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import { bulkUpdateProductsAction, bulkSetPriceAction } from "./actions";
import type { Brand, Category, TaxCategory } from "@snappos/contracts";

interface SearchRow {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_id: string;
  product_name: string;
  brand_name: string | null;
  price_minor: string | null;
  on_hand: string;
  available: string;
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; saved?: string; error?: string }>;
}) {
  const { q, saved, error: loadedError } = await searchParams;

  let rows: SearchRow[] = [];
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let taxCategories: TaxCategory[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (storeId) params.set("store_id", storeId);
    const [result, brandList, categoryList, taxCategoryList] = await Promise.all([
      apiFetch<{ data: SearchRow[] }>(`/api/v1/catalog/products?${params}`),
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
      apiFetch<TaxCategory[]>(`/api/v1/catalog/tax-categories`),
    ]);
    rows = result.data;
    brands = brandList;
    categories = categoryList;
    taxCategories = taxCategoryList;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load the catalog.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Catalog</h1>
        <Link
          href="/catalog/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Add product
        </Link>
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search by name, SKU, or brand"
          className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm"
        >
          Search
        </button>
      </form>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {(error ?? loadedError) ? (
        <p className="text-sm text-[var(--color-error)]">{error ?? loadedError}</p>
      ) : null}

      <form action={bulkUpdateProductsAction} className="flex flex-col gap-3">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="w-8 px-4 py-2"></th>
                <th className="px-4 py-2 font-normal">Product</th>
                <th className="px-4 py-2 font-normal">Brand</th>
                <th className="px-4 py-2 font-normal">SKU</th>
                <th className="px-4 py-2 font-normal">Price</th>
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
                  <td className="px-4 py-2">
                    {row.price_minor !== null ? formatMinor(row.price_minor) : "—"}
                  </td>
                  <td className="px-4 py-2">{row.available}</td>
                </tr>
              ))}
              {rows.length === 0 && !error ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                    {q ? `No match for "${q}".` : "No products yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <span className="text-xs text-[var(--color-text-muted)]">
            Check rows above, then apply a bulk change:
          </span>
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
            type="submit"
            formAction={bulkUpdateProductsAction}
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm"
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
            type="submit"
            formAction={bulkSetPriceAction}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Price selected together
          </button>
        </div>
      </form>
    </div>
  );
}
