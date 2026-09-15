import "server-only";
import { apiFetch } from "@/lib/api";
import type { Category } from "@snappos/contracts";

export interface ProductOption {
  product_id: string;
  product_name: string;
}

/**
 * The lists a segment can filter on, shared by the new and edit pages.
 *
 * Products rather than variants: a segment asks "bought a Geek Bar", not
 * "bought a Geek Bar in Miami Mint" — flavor-level targeting would be a
 * different feature and a much longer dropdown.
 *
 * A failure here returns empty lists rather than throwing. The rest of the
 * segment editor still works without them, and an editor that won't open
 * because the catalog call timed out is worse than two empty dropdowns.
 */
export async function segmentOptions(): Promise<{ products: ProductOption[]; categories: Category[] }> {
  try {
    const [variantResult, categories] = await Promise.all([
      apiFetch<{ data: ProductOption[] }>(`/api/v1/catalog/products?limit=200`),
      apiFetch<Category[]>(`/api/v1/catalog/categories`),
    ]);
    const products = [...new Map(variantResult.data.map((v) => [v.product_id, v])).values()].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );
    return { products, categories };
  } catch {
    return { products: [], categories: [] };
  }
}
