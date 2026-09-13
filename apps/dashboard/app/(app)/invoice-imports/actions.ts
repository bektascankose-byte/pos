"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";

const SPLIT_ROWS = 6;
const EXTRA_VARIANT_ROWS = 7;

interface CreatedInvoiceImport {
  id: string;
}

export async function uploadInvoiceAction(formData: FormData): Promise<void> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(`/invoice-imports/new?error=${encodeURIComponent("Choose a file to upload.")}`);
  }

  const upload = new FormData();
  upload.set("store_id", storeId);
  upload.set("file", file, file.name);

  let created: CreatedInvoiceImport;
  try {
    created = await apiFetch<CreatedInvoiceImport>(`/api/v1/invoice-imports`, {
      method: "POST",
      body: upload,
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not upload that file.";
    redirect(`/invoice-imports/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/invoice-imports/${created.id}?saved=1`);
}

export async function parseInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/parse`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not parse that invoice.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function matchInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/match`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not match those lines.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function resolveLineAction(id: string, lineId: string, formData: FormData): Promise<void> {
  const variantId = String(formData.get("variant_id") ?? "").trim();
  if (!variantId) {
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent("Pick a variant before resolving this line.")}`);
  }
  const isNewProduct = formData.get("is_new_product") === "on";

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, ...(isNewProduct ? { is_new_product: true } : {}) }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not resolve that line.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function ignoreLineAction(id: string, lineId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/ignore`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not ignore that line.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function splitLineAction(id: string, lineId: string, formData: FormData): Promise<void> {
  const items: { variant_id: string; quantity: string; unit_cost?: string }[] = [];
  for (let i = 0; i < SPLIT_ROWS; i++) {
    const variantId = String(formData.get(`variant_id_${i}`) ?? "").trim();
    const quantity = String(formData.get(`quantity_${i}`) ?? "").trim();
    const unitCost = String(formData.get(`unit_cost_${i}`) ?? "").trim();
    if (!variantId || !quantity) continue;
    items.push({ variant_id: variantId, quantity, ...(unitCost ? { unit_cost: unitCost } : {}) });
  }

  if (items.length < 2) {
    redirect(
      `/invoice-imports/${id}/lines/${lineId}/split?error=${encodeURIComponent("Pick a variant and quantity for at least two rows.")}`,
    );
  }

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/split`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not split that line.";
    redirect(`/invoice-imports/${id}/lines/${lineId}/split?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function commitInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/commit`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not commit this invoice.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function addSecondaryBarcodeAction(id: string, lineId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/add-secondary-sku`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that code.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

/**
 * One inline form serves two cases: a brand-new product (name + price
 * required), or a new variant on an existing one (`existing_product_id`
 * given -- name/brand/category are ignored server-side, price falls back to
 * the existing product's own). The API does its own SKU-already-exists
 * cross-check regardless of which case this looks like from here.
 */
export async function createProductForLineAction(id: string, lineId: string, formData: FormData): Promise<void> {
  const existingProductId = String(formData.get("existing_product_id") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const productName = String(formData.get("product_name") ?? "").trim();
  const variantName = String(formData.get("variant_name") ?? "").trim();
  const brandName = String(formData.get("brand_name") ?? "").trim();
  const categoryId = String(formData.get("category_id") ?? "").trim();
  const priceMajor = String(formData.get("price") ?? "").trim();

  if (!sku) {
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent("A SKU / UPC is required.")}`);
  }
  if (existingProductId && !variantName) {
    redirect(
      `/invoice-imports/${id}?error=${encodeURIComponent("Give this variant a name (e.g. the flavor) when attaching it to an existing product.")}`,
    );
  }
  // Whether a new product actually needs a name/price depends on whether
  // this SKU already exists -- a lookup only the API can do. Requiring them
  // here too would wrongly block "type an already-known SKU, expect it to
  // match"; the API enforces this itself once it knows the SKU is genuinely new.

  let priceMinor: string | null = null;
  if (priceMajor) {
    priceMinor = parseMajorToMinor(priceMajor);
    if (priceMinor === null) {
      redirect(`/invoice-imports/${id}?error=${encodeURIComponent("Enter a valid price, like 24.99")}`);
    }
  }

  const extraVariants: { sku: string; variant_name: string; price_minor?: string }[] = [];
  for (let i = 0; i < EXTRA_VARIANT_ROWS; i++) {
    const extraSku = String(formData.get(`extra_sku_${i}`) ?? "").trim();
    const extraVariantName = String(formData.get(`extra_variant_name_${i}`) ?? "").trim();
    const extraPriceMajor = String(formData.get(`extra_price_${i}`) ?? "").trim();
    if (!extraSku || !extraVariantName) continue;

    let extraPriceMinor: string | undefined;
    if (extraPriceMajor) {
      const parsed = parseMajorToMinor(extraPriceMajor);
      if (parsed === null) {
        redirect(`/invoice-imports/${id}?error=${encodeURIComponent(`Row ${i + 1}: enter a valid price, like 24.99`)}`);
      }
      extraPriceMinor = parsed ?? undefined;
    }
    extraVariants.push({ sku: extraSku, variant_name: extraVariantName, ...(extraPriceMinor ? { price_minor: extraPriceMinor } : {}) });
  }

  const body = {
    ...(existingProductId ? { existing_product_id: existingProductId } : {}),
    sku,
    ...(productName ? { product_name: productName } : {}),
    ...(variantName ? { variant_name: variantName } : {}),
    ...(brandName ? { brand_name: brandName } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(priceMinor ? { price_minor: priceMinor } : {}),
    ...(extraVariants.length ? { extra_variants: extraVariants } : {}),
  };

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/create-product`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create or attach that product.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}
