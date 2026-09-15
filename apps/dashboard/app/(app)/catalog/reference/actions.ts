"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { ActionResult } from "@/lib/action-result";
import type { ReferenceSearchRow } from "@snappos/contracts";

export async function searchReferenceAction(query: string): Promise<ActionResult<ReferenceSearchRow[]>> {
  const q = query.trim();
  if (!q) return { ok: true, data: [] };

  try {
    const rows = await apiFetch<ReferenceSearchRow[]>(
      `/api/v1/reference/search?q=${encodeURIComponent(q)}&limit=100`,
    );
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not search known products." };
  }
}

/**
 * Turn a known product into one this shop actually sells.
 *
 * Creates the catalog item and nothing else. Stock is not touched: having an
 * item and having some of it are separate facts, and stock only ever comes
 * from the ledger -- receive or count it to say how many there are.
 */
export async function promoteReferenceAction(
  referenceId: string,
  storeId: string | null,
  formData: FormData,
): Promise<ActionResult<{ product_id: string; name: string }>> {
  const body: Record<string, string> = {};

  const name = String(formData.get("name") ?? "").trim();
  if (name) body.name = name;

  const categoryId = String(formData.get("category_id") ?? "").trim();
  if (categoryId) body.category_id = categoryId;

  const brandId = String(formData.get("brand_id") ?? "").trim();
  if (brandId) body.brand_id = brandId;

  const price = String(formData.get("price") ?? "").trim();
  if (price) {
    const minor = parseMajorToMinor(price);
    if (minor === null) return { ok: false, error: "Price has to look like 9.99." };
    body.price_minor = minor;
  }

  const cost = String(formData.get("cost") ?? "").trim();
  if (cost) {
    if (!/^\d+(\.\d{1,6})?$/.test(cost)) return { ok: false, error: "Cost has to be a number, like 3.50." };
    body.cost = cost;
  }

  try {
    const data = await apiFetch<{ product_id: string; variant_id: string; name: string }>(
      `/api/v1/reference/${referenceId}/promote${storeId ? `?store_id=${storeId}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    revalidatePath("/catalog");
    return { ok: true, data: { product_id: data.product_id, name: data.name } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that to your catalog." };
  }
}
