"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { AiProductDraft, AiImageSearchResult, Product } from "@snappos/contracts";

/**
 * Ask for a draft of this product's whole entry.
 *
 * Nothing is saved. What comes back is shown for review and only the parts
 * someone ticks are applied -- see `applyAiDraftAction`.
 */
export async function aiFillProductAction(
  productId: string,
  hint: string,
): Promise<ActionResult<AiProductDraft>> {
  try {
    const draft = await apiFetch<AiProductDraft>(`/api/v1/catalog/products/${productId}/ai-fill`, {
      method: "POST",
      body: JSON.stringify(hint.trim() ? { hint: hint.trim() } : {}),
    });
    return { ok: true, data: draft };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not draft this item.",
    };
  }
}

/** Addresses of stock photos for these flavors. The browser fetches and uploads them. */
export async function aiFindImagesAction(
  productId: string,
  variants: string[],
): Promise<ActionResult<AiImageSearchResult>> {
  try {
    const found = await apiFetch<AiImageSearchResult>(
      `/api/v1/catalog/products/${productId}/ai-images`,
      { method: "POST", body: JSON.stringify({ variants }) },
    );
    return { ok: true, data: found };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not look for photos.",
    };
  }
}

interface ApplyDraft {
  name?: string;
  short_name?: string;
  description?: string;
  brand_id?: string | null;
  category_id?: string | null;
  tax_category_id?: string | null;
  tags?: string[];
  compliance?: AiProductDraft["compliance"];
  /** Flavor names to create. Ones the product already has are not passed. */
  newVariants?: string[];
}

/**
 * Write the parts of a draft somebody kept.
 *
 * The product's own fields and its compliance go in one PATCH, which is how
 * the rest of this page already saves compliance -- so a draft cannot land
 * half applied, with a new name against the old age restriction.
 *
 * New flavors are created without barcodes or prices on purpose. Those are the
 * two things the AI is not allowed to invent -- a wrong barcode scans as the
 * wrong item and a wrong price is money -- so each new flavor arrives visibly
 * unfinished and cannot reach a register until somebody types them in. That is
 * the same rule the Send page enforces from the other end.
 *
 * A null brand, category or tax category is left out rather than sent: the
 * update schema takes an id or nothing, and "the AI could not place this" is
 * not an instruction to clear what somebody already set.
 */
export async function applyAiDraftAction(
  productId: string,
  draft: ApplyDraft,
): Promise<ActionResult<{ product: Product; created: number; failed: string[] }>> {
  try {
    const fields: Record<string, unknown> = {};
    if (draft.name !== undefined) fields.name = draft.name;
    if (draft.short_name !== undefined) fields.short_name = draft.short_name.slice(0, 64);
    if (draft.description !== undefined) fields.description = draft.description.slice(0, 4096);
    if (draft.brand_id) fields.brand_id = draft.brand_id;
    if (draft.category_id) fields.category_id = draft.category_id;
    if (draft.tax_category_id) fields.tax_category_id = draft.tax_category_id;
    if (draft.tags !== undefined) fields.tags = draft.tags;
    if (draft.compliance) fields.compliance = draft.compliance;

    let product: Product;
    if (Object.keys(fields).length > 0) {
      product = await apiFetch<Product>(`/api/v1/catalog/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
    } else {
      product = await apiFetch<Product>(`/api/v1/catalog/products/${productId}`);
    }

    // One flavor failing (a name clashing with one already there, say) should
    // not lose the rest, so each is reported rather than thrown.
    let created = 0;
    const failed: string[] = [];
    for (const name of draft.newVariants ?? []) {
      try {
        await apiFetch(`/api/v1/catalog/products/${productId}/variants`, {
          method: "POST",
          body: JSON.stringify({
            // A placeholder SKU: the API turns it into the real barcode as
            // soon as one is added, the convention every imported item follows.
            sku: `TMP-${slug(name)}-${Date.now().toString(36)}`,
            variant_name: name,
          }),
        });
        created += 1;
      } catch {
        failed.push(name);
      }
    }

    if (created > 0) product = await apiFetch<Product>(`/api/v1/catalog/products/${productId}`);

    revalidatePath(`/catalog/${productId}`);
    revalidatePath("/catalog");
    return { ok: true, data: { product, created, failed } };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not save that draft.",
    };
  }
}

function slug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "FLAVOR";
}
