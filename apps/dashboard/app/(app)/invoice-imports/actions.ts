"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import { normalizePhone } from "@/lib/phone";
import type { ActionResult } from "@/lib/action-result";
import type { VendorSuggestion } from "@snappos/contracts";

interface CreatedInvoiceImport {
  id: string;
}

export async function uploadInvoiceAction(formData: FormData): Promise<void> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(`/invoice-imports/new?error=${encodeURIComponent("Choose a file to upload.")}`);
  }

  const upload = new FormData();
  upload.set("store_id", storeId);
  if (vendorId) upload.set("vendor_id", vendorId);
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

export async function parseInvoiceAction(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/parse`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not parse that invoice." };
  }
}

export async function matchInvoiceAction(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/match`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not match those lines." };
  }
}

/** Reads the vendor off the document and returns the shortlist. Writes nothing -- see `assignVendorAction`. */
export async function suggestVendorAction(id: string): Promise<ActionResult<VendorSuggestion>> {
  try {
    const data = await apiFetch<VendorSuggestion>(`/api/v1/invoice-imports/${id}/suggest-vendor`, {
      method: "POST",
    });
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not read a vendor off this invoice.",
    };
  }
}

/** The human half: file this invoice under a vendor that already exists. */
export async function assignVendorAction(id: string, vendorId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/assign-vendor`, {
      method: "POST",
      body: JSON.stringify({ vendor_id: vendorId }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not file this invoice." };
  }
}

/**
 * Create the vendor the document describes, then file the invoice under it --
 * the "none of these are them" path. Still two separate API calls on purpose:
 * the vendor is a real record that outlives this invoice, created through the
 * same endpoint the vendor form uses, not a side effect of an import.
 *
 * `code` isn't something an invoice prints, so one is derived from the name
 * and offered for editing on the vendor's own page afterwards.
 */
export async function createVendorForInvoiceAction(
  id: string,
  vendor: { name: string; code: string; phone?: string; email?: string; website?: string; address_line1?: string; city?: string; region?: string; postal_code?: string; payment_terms?: string },
): Promise<ActionResult<{ id: string }>> {
  const body: Record<string, unknown> = { code: vendor.code, name: vendor.name };
  for (const field of ["website", "address_line1", "city", "region", "postal_code", "payment_terms"] as const) {
    const value = vendor[field]?.trim();
    if (value) body[field] = value;
  }
  // Phone and email go through the same normalization and the same validation
  // every other form uses: a number the model read off a letterhead as
  // "(800) 555-0100" is no more E.164 than one a person types.
  const phone = vendor.phone?.trim();
  if (phone) body.phone = normalizePhone(phone);
  const email = vendor.email?.trim();
  if (email) body.email = email;

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(`/api/v1/purchasing/vendors`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create that vendor." };
  }

  const assigned = await assignVendorAction(id, created.id);
  if (!assigned.ok) return assigned;
  return { ok: true, data: created };
}

export async function resolveLineAction(id: string, lineId: string, formData: FormData): Promise<ActionResult> {
  const variantId = String(formData.get("variant_id") ?? "").trim();
  if (!variantId) {
    return { ok: false, error: "Pick a variant before resolving this line." };
  }
  const isNewProduct = formData.get("is_new_product") === "on";

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, ...(isNewProduct ? { is_new_product: true } : {}) }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not resolve that line." };
  }
}

export async function ignoreLineAction(id: string, lineId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/ignore`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not ignore that line." };
  }
}

/** `rowCount` is however many rows the client rendered -- its own "Add another row" click count. */
export async function splitLineAction(
  id: string,
  lineId: string,
  formData: FormData,
  rowCount: number,
): Promise<ActionResult> {
  const items: { variant_id: string; quantity: string; unit_cost?: string }[] = [];
  for (let i = 0; i < rowCount; i++) {
    const variantId = String(formData.get(`variant_id_${i}`) ?? "").trim();
    const quantity = String(formData.get(`quantity_${i}`) ?? "").trim();
    const unitCost = String(formData.get(`unit_cost_${i}`) ?? "").trim();
    if (!variantId || !quantity) continue;
    items.push({ variant_id: variantId, quantity, ...(unitCost ? { unit_cost: unitCost } : {}) });
  }

  if (items.length < 2) {
    return { ok: false, error: "Pick a variant and quantity for at least two rows." };
  }

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/split`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not split that line." };
  }
}

export async function commitInvoiceAction(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/commit`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not commit this invoice." };
  }
}

export async function addSecondaryBarcodeAction(id: string, lineId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/add-secondary-sku`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that code." };
  }
}

/**
 * One inline form serves two cases: a brand-new product (name + price
 * required), or a new variant on an existing one (`existing_product_id`
 * given -- name/brand/category are ignored server-side, price falls back to
 * the existing product's own). The API does its own SKU-already-exists
 * cross-check regardless of which case this looks like from here.
 *
 * The client renders every variant as a uniform row (`sku_i`/`variant_name_i`/
 * `price_i`, `rowCount` of them, `i` from 0) -- there's no separate "main SKU"
 * field in the UI. Row 0 is what the wire format's top-level `sku`/
 * `variant_name`/`price_minor` actually are; rows 1..rowCount-1 map to
 * `extra_variants[]` exactly as before. This mapping is purely an
 * action-layer detail -- the API contract and `InvoicingService` logic are
 * unchanged. A blank added row (rows 1+, missing either its SKU or its name)
 * is silently skipped, same tolerance as before; row 0 is the one mandatory
 * variant, since some row has to supply the wire format's required `sku`.
 * A row 0 with no price of its own falls back to the shared "starting price"
 * field -- the wire format has no such fallback for its top-level price
 * (only `extra_variants[]` entries fall back server-side), so that fallback
 * is resolved here before sending.
 */
export async function createProductForLineAction(
  id: string,
  lineId: string,
  formData: FormData,
  rowCount: number,
): Promise<ActionResult> {
  const existingProductId = String(formData.get("existing_product_id") ?? "").trim();
  const productName = String(formData.get("product_name") ?? "").trim();
  const brandName = String(formData.get("brand_name") ?? "").trim();
  const categoryId = String(formData.get("category_id") ?? "").trim();

  const rows = Array.from({ length: Math.max(rowCount, 1) }, (_, i) => ({
    sku: String(formData.get(`sku_${i}`) ?? "").trim(),
    variantName: String(formData.get(`variant_name_${i}`) ?? "").trim(),
    priceMajor: String(formData.get(`price_${i}`) ?? "").trim(),
  }));
  // `rows` always has at least one entry (`Math.max(rowCount, 1)` above).
  const firstRow = rows[0]!;
  const restRows = rows.slice(1);

  if (!firstRow.sku) {
    return { ok: false, error: "A UPC is required." };
  }
  if (existingProductId && !firstRow.variantName) {
    return {
      ok: false,
      error: "Give this variant a name (e.g. the flavor) when attaching it to an existing product.",
    };
  }
  // Whether a new product actually needs a name/price depends on whether
  // this SKU already exists -- a lookup only the API can do. Requiring them
  // here too would wrongly block "type an already-known SKU, expect it to
  // match"; the API enforces this itself once it knows the SKU is genuinely new.

  let firstPriceMinor: string | undefined;
  if (firstRow.priceMajor) {
    const parsed = parseMajorToMinor(firstRow.priceMajor);
    if (parsed === null) {
      return { ok: false, error: "Enter a valid price, like 24.99" };
    }
    firstPriceMinor = parsed;
  }

  const startingPriceMajor = String(formData.get("starting_price") ?? "").trim();
  let startingPriceMinor: string | null = null;
  if (startingPriceMajor) {
    startingPriceMinor = parseMajorToMinor(startingPriceMajor);
    if (startingPriceMinor === null) {
      return { ok: false, error: "Enter a valid starting price, like 24.99" };
    }
  }

  const resolvedFirstPriceMinor = firstPriceMinor ?? startingPriceMinor ?? undefined;
  if (!existingProductId && !resolvedFirstPriceMinor) {
    return { ok: false, error: "Enter a starting price, or a price for the first variant." };
  }

  const extraVariants: { sku: string; variant_name: string; price_minor?: string }[] = [];
  for (let i = 0; i < restRows.length; i++) {
    const row = restRows[i]!;
    if (!row.sku || !row.variantName) continue;

    let rowPriceMinor: string | undefined;
    if (row.priceMajor) {
      const parsed = parseMajorToMinor(row.priceMajor);
      if (parsed === null) {
        return { ok: false, error: `Row ${i + 2}: enter a valid price, like 24.99` };
      }
      rowPriceMinor = parsed;
    }
    extraVariants.push({ sku: row.sku, variant_name: row.variantName, ...(rowPriceMinor ? { price_minor: rowPriceMinor } : {}) });
  }

  const body = {
    ...(existingProductId ? { existing_product_id: existingProductId } : {}),
    sku: firstRow.sku,
    ...(productName ? { product_name: productName } : {}),
    ...(firstRow.variantName ? { variant_name: firstRow.variantName } : {}),
    ...(brandName ? { brand_name: brandName } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(resolvedFirstPriceMinor ? { price_minor: resolvedFirstPriceMinor } : {}),
    ...(extraVariants.length ? { extra_variants: extraVariants } : {}),
  };

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/create-product`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create or attach that product." };
  }
}
