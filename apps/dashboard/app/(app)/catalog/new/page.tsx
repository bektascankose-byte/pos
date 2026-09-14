import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Brand, Category } from "@snappos/contracts";
import { NewProductClient } from "./NewProductClient";

export default async function NewProductPage() {
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let loadError: string | null = null;
  const storeId = await primaryStoreId();
  try {
    [brands, categories] = await Promise.all([
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
    ]);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load brands and categories.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return <NewProductClient brands={brands} categories={categories} storeId={storeId} />;
}
