"use server";

import { revalidatePath } from "next/cache";
import { apiFetchRaw } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { ProductImage } from "@snappos/contracts";

/**
 * Pass an already-scaled photo through to the API.
 *
 * The browser does the downscaling before this is called — see `ImagePanel` —
 * so this only forwards bytes. That split keeps an image-processing library
 * out of the server entirely, and puts the decision about how large a photo
 * needs to be next to the code that knows how large it will be drawn.
 */
export async function uploadProductImageAction(
  productId: string,
  formData: FormData,
): Promise<ActionResult<ProductImage[]>> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Pick an image first." };
  }

  const forwarded = new FormData();
  forwarded.set("file", file);
  const thumb = formData.get("thumb");
  if (thumb instanceof File && thumb.size > 0) forwarded.set("thumb", thumb);

  const variantId = String(formData.get("variant_id") ?? "").trim();
  if (variantId) forwarded.set("variant_id", variantId);
  else forwarded.set("product_id", productId);

  const altText = String(formData.get("alt_text") ?? "").trim();
  if (altText) forwarded.set("alt_text", altText);

  try {
    const response = await apiFetchRaw(`/api/v1/catalog/images`, {
      method: "POST",
      body: forwarded,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: body?.user_message ?? body?.message ?? "Could not save that image." };
    }
    revalidatePath(`/catalog/${productId}`);
    revalidatePath("/catalog");
    return { ok: true, data: body.images as ProductImage[] };
  } catch {
    return { ok: false, error: "Could not save that image." };
  }
}

export async function removeProductImageAction(
  productId: string,
  imageId: string,
): Promise<ActionResult<ProductImage[]>> {
  try {
    const response = await apiFetchRaw(`/api/v1/catalog/images/${imageId}`, { method: "DELETE" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: body?.user_message ?? body?.message ?? "Could not remove that image." };
    }
    revalidatePath(`/catalog/${productId}`);
    revalidatePath("/catalog");
    return { ok: true, data: body.images as ProductImage[] };
  } catch {
    return { ok: false, error: "Could not remove that image." };
  }
}

/** Reordering is how the main photo is chosen — whatever is first wins. */
export async function reorderProductImagesAction(
  productId: string,
  imageIds: string[],
): Promise<ActionResult<ProductImage[]>> {
  try {
    const response = await apiFetchRaw(`/api/v1/catalog/images/reorder`, {
      method: "POST",
      body: JSON.stringify({ image_ids: imageIds }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: body?.user_message ?? body?.message ?? "Could not reorder those." };
    }
    revalidatePath(`/catalog/${productId}`);
    revalidatePath("/catalog");
    return { ok: true, data: body.images as ProductImage[] };
  } catch {
    return { ok: false, error: "Could not reorder those." };
  }
}
