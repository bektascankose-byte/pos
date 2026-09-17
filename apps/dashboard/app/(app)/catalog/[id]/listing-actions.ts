"use server";

import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { ActionResult } from "@/lib/action-result";
import type { VariantListing } from "@snappos/contracts";

export async function getListingsAction(
  productId: string,
  storeId: string,
): Promise<ActionResult<VariantListing[]>> {
  try {
    const data = await apiFetch<VariantListing[]>(
      `/api/v1/storefront/listings?store_id=${storeId}&product_id=${productId}`,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not load the online settings." };
  }
}

export interface ListingForm {
  listed: boolean;
  safetyStock: string;
  maxPerOrder: string;
  onlinePrice: string;
}

/**
 * Save one variant's online settings.
 *
 * Blank means "none": no limit per order, and the counter price rather than an
 * online one. Those are sent as explicit clears, because leaving a field out
 * keeps whatever was set before -- which is right for a partial update and
 * wrong for somebody who just emptied the box.
 */
export async function saveListingAction(variantId: string, form: ListingForm): Promise<ActionResult<null>> {
  const safety = form.safetyStock.trim() || "0";
  if (!/^\d{1,5}$/.test(safety)) return { ok: false, error: "Safety stock must be a whole number." };

  const max = form.maxPerOrder.trim();
  if (max && !/^[1-9]\d{0,3}$/.test(max)) return { ok: false, error: "The limit per order must be a whole number above zero." };

  const price = form.onlinePrice.trim();
  const priceMinor = price ? parseMajorToMinor(price) : null;
  if (price && (priceMinor === null || priceMinor.startsWith("-"))) {
    return { ok: false, error: `"${price}" isn't a price.` };
  }

  try {
    await apiFetch(`/api/v1/storefront/listings/${variantId}`, {
      method: "POST",
      body: JSON.stringify({
        availability: form.listed ? "pickup_only" : "hidden",
        safety_stock: safety,
        ...(max ? { max_per_order: max } : { clear_max_per_order: true }),
        ...(priceMinor ? { online_price_minor: priceMinor } : { clear_online_price: true }),
      }),
    });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save the online settings." };
  }
}
