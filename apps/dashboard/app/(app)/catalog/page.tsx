import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";

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
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let rows: SearchRow[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (storeId) params.set("store_id", storeId);
    const result = await apiFetch<{ data: SearchRow[] }>(`/api/v1/catalog/products?${params}`);
    rows = result.data;
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

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
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
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  {q ? `No match for "${q}".` : "No products yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
