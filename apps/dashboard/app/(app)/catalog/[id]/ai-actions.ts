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
  /** A brand the shop does not have yet, by name. Created on save. */
  brand_name?: string;
  category_id?: string | null;
  tax_category_id?: string | null;
  tags?: string[];
  compliance?: AiProductDraft["compliance"];
  /** Flavor names to create. Ones the product already has are not passed. */
  newVariants?: string[];
  /**
   * Existing variants that have no flavor name yet, and the flavor the draft
   * recognised them as: the item already on the shelf, named rather than
   * duplicated.
   */
  nameVariants?: { id: string; name: string }[];
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
 * A null brand, category or tax category is left out rather than sent: "the
 * AI could not place this" is not an instruction to clear what somebody
 * already set. A brand the shop has never had is the exception: it arrives
 * by name and the API adds it, since a new product line from a new maker is
 * exactly when that happens.
 */
export async function applyAiDraftAction(
  productId: string,
  draft: ApplyDraft,
): Promise<ActionResult<{ product: Product; created: number; named: number; failed: string[] }>> {
  try {
    const fields: Record<string, unknown> = {};
    if (draft.name !== undefined) fields.name = draft.name;
    if (draft.short_name !== undefined) fields.short_name = draft.short_name.slice(0, 64);
    if (draft.description !== undefined) fields.description = draft.description.slice(0, 4096);
    if (draft.brand_id) fields.brand_id = draft.brand_id;
    else if (draft.brand_name?.trim()) fields.brand_name = draft.brand_name.trim().slice(0, 128);
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

    // The item already on the shelf first, so it carries its flavor before
    // the new ones arrive beside it.
    let named = 0;
    for (const { id, name } of draft.nameVariants ?? []) {
      try {
        await apiFetch(`/api/v1/catalog/variants/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ variant_name: name }),
        });
        named += 1;
      } catch {
        failed.push(name);
      }
    }

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

    if (created > 0 || named > 0) product = await apiFetch<Product>(`/api/v1/catalog/products/${productId}`);

    revalidatePath(`/catalog/${productId}`);
    revalidatePath("/catalog");
    return { ok: true, data: { product, created, named, failed } };
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
