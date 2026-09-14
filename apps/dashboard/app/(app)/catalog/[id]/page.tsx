import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Product, Brand, Category, TaxCategory } from "@snappos/contracts";
import { ProductDetailClient } from "./ProductDetailClient";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storeId = await primaryStoreId();

  let product: Product;
  let brands: Brand[] = [];
  let categories: Category[] = [];
  let taxCategories: TaxCategory[] = [];
  try {
    const qs = storeId ? `?store_id=${storeId}` : "";
    [product, brands, categories, taxCategories] = await Promise.all([
      apiFetch<Product>(`/api/v1/catalog/products/${id}${qs}`),
      apiFetch<Brand[]>(`/api/v1/catalog/brands`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
      apiFetch<TaxCategory[]>(`/api/v1/catalog/tax-categories`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  return (
    <ProductDetailClient
      productId={id}
      storeId={storeId}
      initialProduct={product}
      brands={brands}
      categories={categories}
      taxCategories={taxCategories}
    />
  );
}
