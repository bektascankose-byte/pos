import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { formatMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { PriceCategory } from "@snappos/contracts";

export default async function PriceCategoriesPage() {
  let categories: PriceCategory[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    categories = await apiFetch<PriceCategory[]>(`/api/v1/catalog/price-categories?${params}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load price categories.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Price categories</h1>
        <Link
          href="/catalog/price-categories/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          New category
        </Link>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Group items so their price can be changed all at once later. Add members from the{" "}
        <Link href="/catalog" className="text-[var(--color-accent)]">
          catalog list
        </Link>{" "}
        or by scanning them on a category&apos;s own page.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Members</th>
              <th className="px-4 py-2 font-normal">Price</th>
              <th className="px-4 py-2 font-normal">Off the group price</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/catalog/price-categories/${c.id}`} className="text-[var(--color-accent)]">
                    {c.name ?? "(unnamed)"}
                  </Link>
                </td>
                <td className="px-4 py-2">{c.member_count}</td>
                <td className="px-4 py-2">
                  {/* `current_price_minor` types as the branded `Money` here because it shares
                      `priceCategorySchema` with request validation, but this response was never
                      actually parsed through that schema -- it's the plain digit string (or null)
                      the API sends. `String()` bridges that gap at the boundary. */}
                  {c.current_price_minor !== null ? formatMinor(String(c.current_price_minor)) : "mixed / —"}
                </td>
                <td className="px-4 py-2">
                  {c.mismatch_count > 0 ? (
                    <Link
                      href={`/catalog/price-categories/${c.id}`}
                      className="font-medium text-[var(--color-error)]"
                    >
                      {c.mismatch_count} item{c.mismatch_count === 1 ? "" : "s"}
                    </Link>
                  ) : (
                    <span className="text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
              </tr>
            ))}
            {categories.length === 0 && !error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No price categories yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
