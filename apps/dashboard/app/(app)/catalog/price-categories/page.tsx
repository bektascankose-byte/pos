import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { PriceCategory } from "@snappos/contracts";
import { PriceCategoriesClient } from "./PriceCategoriesClient";

export default async function PriceCategoriesPage() {
  let categories: PriceCategory[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    categories = await apiFetch<PriceCategory[]>(`/api/v1/catalog/price-categories?${params}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load price groups.";
  }

  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;

  return <PriceCategoriesClient categories={categories} />;
}
