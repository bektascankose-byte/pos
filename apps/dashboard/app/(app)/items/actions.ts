"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { Product, ReferenceProduct } from "@snappos/contracts";

export interface SearchHit {
  variant_id: string;
  product_id: string;
  product_name: string;
  variant_name: string | null;
  sku: string;
  brand_name: string | null;
  price_minor: string | null;
}

interface ResolvedCode {
  variant_id: string;
  product_id: string;
  matched_kind: string | null;
  matched_units: string | null;
}

/**
 * Stock by variant id. Kept beside the product rather than merged into it:
 * the catalog's product endpoint doesn't carry stock (only the register's own
 * search does), so this is a second read, and keeping it separate avoids
 * pretending the catalog response had it all along.
 */
export type StockByVariant = Record<string, { on_hand: string; available: string }>;

export interface ItemDetail {
  product: Product;
  stock: StockByVariant;
}

/**
 * One scan box, three outcomes: the code resolves to a real item (its own
 * barcode, a carton code, or its SKU -- `GET catalog/resolve/:code` checks all
 * of them), or it doesn't and the text is worth searching by name, or nothing
 * matches at all and the page offers to create it.
 *
 * The last case carries whatever the reference catalog knows about the code.
 * That is the whole reason the old system's item file was kept: a code this
 * catalog has never seen is usually not a new product in the world, only new
 * *here*, and its name, price and cost are already on record.
 */
export type LookupResult =
  | { kind: "item"; item: ItemDetail; matchedVariantId: string; matchedKind: string | null; matchedUnits: string | null }
  | { kind: "matches"; hits: SearchHit[] }
  | { kind: "none"; reference: ReferenceProduct | null };

export async function lookupItemAction(code: string, storeId: string | null): Promise<ActionResult<LookupResult>> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: "Scan or type a code first." };
  }

  const storeQuery = storeId ? `?store_id=${storeId}` : "";
  try {
    const resolved = await apiFetch<{ match: ResolvedCode | null }>(
      `/api/v1/catalog/resolve/${encodeURIComponent(trimmed)}`,
    );

    if (resolved.match) {
      return {
        ok: true,
        data: {
          kind: "item",
          item: await loadItem(resolved.match.product_id, storeId),
          matchedVariantId: resolved.match.variant_id,
          matchedKind: resolved.match.matched_kind,
          matchedUnits: resolved.match.matched_units,
        },
      };
    }

    const search = await apiFetch<{ data: SearchHit[] }>(
      `/api/v1/catalog/products${storeQuery ? `${storeQuery}&` : "?"}q=${encodeURIComponent(trimmed)}`,
    );
    if (search.data.length > 0) {
      return { ok: true, data: { kind: "matches", hits: search.data } };
    }

    return { ok: true, data: { kind: "none", reference: await lookupReference(trimmed) } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not look that code up." };
  }
}

/**
 * What the old system knew about a code this catalog doesn't.
 *
 * Never allowed to fail the lookup it decorates: a reference miss, or the
 * whole reference catalog being empty, is the normal case for a shop that
 * never imported one. The scan still has to end in "nothing on file — add
 * it", which is a perfectly good answer.
 */
async function lookupReference(code: string): Promise<ReferenceProduct | null> {
  try {
    const found = await apiFetch<{ match: ReferenceProduct | null }>(
      `/api/v1/reference/lookup/${encodeURIComponent(code)}`,
    );
    return found.match;
  } catch {
    return null;
  }
}

/** Used when picking a search hit, and to re-read an item after its codes change. */
export async function getItemAction(
  productId: string,
  storeId: string | null,
): Promise<ActionResult<ItemDetail>> {
  try {
    return { ok: true, data: await loadItem(productId, storeId) };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not load that item." };
  }
}

async function loadItem(productId: string, storeId: string | null): Promise<ItemDetail> {
  const product = await apiFetch<Product>(
    `/api/v1/catalog/products/${productId}${storeId ? `?store_id=${storeId}` : ""}`,
  );

  const stock: StockByVariant = {};
  if (storeId) {
    const levels = await Promise.all(
      (product.variants ?? []).map(async (variant) => {
        try {
          const row = await apiFetch<{ on_hand: string; available: string }>(
            `/api/v1/inventory/stock/${variant.id}?store_id=${storeId}`,
          );
          return [variant.id, { on_hand: row.on_hand, available: row.available }] as const;
        } catch {
          // A variant that has never moved has no stock row at all, which is
          // not an error worth failing the whole card over.
          return null;
        }
      }),
    );
    for (const level of levels) {
      if (level) stock[level[0]] = level[1];
    }
  }

  return { product, stock };
}

/**
 * A carton code is just a barcode whose `units` is above 1 -- the register
 * multiplies by it, so a case of 10 rings up ten of this same item.
 */
export async function addVariantBarcodeAction(
  variantId: string,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const barcode = String(formData.get("barcode") ?? "").trim();
  const kind = String(formData.get("kind") ?? "case").trim();
  const units = String(formData.get("units") ?? "").trim();

  if (!barcode) {
    return { ok: false, error: "Scan or type the code to add." };
  }
  if (units && !/^\d+(\.\d+)?$/.test(units)) {
    return { ok: false, error: "Units has to be a number, like 10." };
  }
  if (units && Number(units) < 1) {
    return { ok: false, error: "A code has to stand for at least one unit." };
  }

  try {
    const data = await apiFetch<{ id: string }>(`/api/v1/catalog/variants/${variantId}/barcodes`, {
      method: "POST",
      body: JSON.stringify({ barcode, kind, ...(units ? { units } : {}) }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that code." };
  }
}

export async function removeVariantBarcodeAction(barcodeId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/catalog/variants/barcodes/${barcodeId}/remove`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that code." };
  }
}
