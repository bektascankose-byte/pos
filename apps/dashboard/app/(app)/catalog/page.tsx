import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Brand, Category, TaxCategory, PriceCategory } from "@snappos/contracts";
import { CatalogListClient } from "./CatalogListClient";

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

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let rows: SearchRow[] = [];
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let taxCategories: TaxCategory[] = [];
  let priceCategories: PriceCategory[] = [];
  let error: string | null = null;
  const storeId = await primaryStoreId();
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (storeId) params.set("store_id", storeId);
    const [result, brandList, categoryList, taxCategoryList, priceCategoryList] = await Promise.all([
      apiFetch<{ data: SearchRow[] }>(`/api/v1/catalog/products?${params}`),
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
      apiFetch<TaxCategory[]>(`/api/v1/catalog/tax-categories`),
      apiFetch<PriceCategory[]>(`/api/v1/catalog/price-categories`),
    ]);
    rows = result.data;
    brands = brandList;
    categories = categoryList;
    taxCategories = taxCategoryList;
    priceCategories = priceCategoryList;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load the catalog.";
  }

  if (error) {
    return <p className="text-sm text-[var(--color-error)]">{error}</p>;
  }

  return (
    <CatalogListClient
      initialRows={rows}
      initialQuery={q ?? ""}
      storeId={storeId}
      brands={brands}
      categories={categories}
      taxCategories={taxCategories}
      priceCategories={priceCategories}
    />
  );
}
