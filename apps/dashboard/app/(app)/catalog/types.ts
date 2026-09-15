/**
 * One row of the catalog list, as `CatalogService.search` returns it.
 *
 * Shared rather than declared in both the page and the client component,
 * which is how it was: the two copies drifted the first time a column was
 * added and the mismatch only showed up as a runtime blank.
 */
export interface SearchRow {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  plu: string | null;
  product_id: string;
  product_name: string;
  brand_id: string | null;
  brand_name: string | null;
  category_id: string | null;
  category_name: string | null;
  price_group_id: string | null;
  price_group_name: string | null;
  price_minor: string | null;
  cost: string | null;
  on_hand: string;
  available: string;
}
