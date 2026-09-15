import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Brand, Category, ReferenceSourceStats } from "@snappos/contracts";
import { ReferenceClient } from "./ReferenceClient";

/**
 * Products the shop knows about but does not stock.
 *
 * Its own page rather than a filter on the item list, because these are not
 * items: nothing here has a price the register will honour, a stock level, or
 * a place in a report. Mixing them into the catalog would mean explaining
 * that distinction on every screen instead of one.
 */
export default async function ReferencePage() {
  let stats: ReferenceSourceStats[] = [];
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let error: string | null = null;
  const storeId = await primaryStoreId();

  try {
    [stats, brands, categories] = await Promise.all([
      apiFetch<ReferenceSourceStats[]>(`/api/v1/reference/stats`),
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load the reference catalog.";
  }

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;

  return <ReferenceClient stats={stats} brands={brands} categories={categories} storeId={storeId} />;
}
