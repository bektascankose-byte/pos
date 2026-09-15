import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { StockLevelRow, Category, Brand, PriceCategory } from "@snappos/contracts";
import { InventoryClient } from "./InventoryClient";

export default async function InventoryPage() {
  let rows: StockLevelRow[] = [];
  let error: string | null = null;
  const storeId = await primaryStoreId();

  try {
    rows = storeId
      ? await apiFetch<StockLevelRow[]>(`/api/v1/inventory/stock?store_id=${storeId}`)
      : [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load stock levels.";
  }

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;

  // Lookups for the row editor and for choosing a shelf to count. A failure
  // here leaves counting-by-scan and the list itself working, so it doesn't
  // take the page down with it.
  const [categories, brands, priceGroups] = await Promise.all([
    apiFetch<Category[]>(`/api/v1/catalog/categories`).catch(() => []),
    apiFetch<Brand[]>(`/api/v1/catalog/brands`).catch(() => []),
    apiFetch<PriceCategory[]>(`/api/v1/catalog/price-categories`).catch(() => []),
  ]);

  return (
    <InventoryClient
      initialRows={rows}
      categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      brands={brands.map((b) => ({ id: b.id, name: b.name }))}
      priceGroups={priceGroups.map((p) => ({ id: p.id, name: p.name ?? "(unnamed)" }))}
      storeId={storeId}
    />
  );
}
