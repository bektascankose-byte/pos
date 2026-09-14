"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { ActionResult } from "@/lib/action-result";
import type { Product, Variant, AiComplianceSuggestion } from "@snappos/contracts";

interface CreatedVariant {
  id: string;
  sku: string;
}

export async function updateProductAction(id: string, formData: FormData): Promise<ActionResult<Product>> {
  const body: Record<string, unknown> = {};
  for (const field of ["name", "short_name", "description", "unit_type"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }
  for (const field of ["brand_id", "category_id", "tax_category_id"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }
  const tags = String(formData.get("tags") ?? "").trim();
  if (tags) {
    body.tags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  try {
    const data = await apiFetch<Product>(`/api/v1/catalog/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save changes." };
  }
}

export async function updateVariantAction(
  productId: string,
  variantId: string,
  formData: FormData,
): Promise<ActionResult<Variant>> {
  const body: Record<string, unknown> = {};
  const variantName = String(formData.get("variant_name") ?? "").trim();
  if (variantName) body.variant_name = variantName;
  const cost = String(formData.get("cost") ?? "").trim();
  if (cost) body.cost = cost;
  const caseQty = String(formData.get("case_quantity") ?? "").trim();
  if (caseQty) body.case_quantity = Number(caseQty);
  const packQty = String(formData.get("pack_quantity") ?? "").trim();
  if (packQty) body.pack_quantity = Number(packQty);
  const reorderPoint = String(formData.get("reorder_point") ?? "").trim();
  if (reorderPoint) body.reorder_point = reorderPoint;
  const reorderQuantity = String(formData.get("reorder_quantity") ?? "").trim();
  if (reorderQuantity) body.reorder_quantity = reorderQuantity;
  const status = String(formData.get("status") ?? "").trim();
  if (status) body.status = status;

  try {
    const data = await apiFetch<Variant>(`/api/v1/catalog/variants/${variantId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save changes." };
  }
}

export async function addVariantAction(
  productId: string,
  formData: FormData,
): Promise<ActionResult<CreatedVariant>> {
  const variantName = String(formData.get("variant_name") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const attributeValue = String(formData.get("attribute_value") ?? "").trim();
  const cost = String(formData.get("cost") ?? "").trim() || "0";
  const barcode = String(formData.get("barcode") ?? "").trim();
  const caseQty = String(formData.get("case_quantity") ?? "").trim() || "1";
  const packQty = String(formData.get("pack_quantity") ?? "").trim() || "1";

  if (!variantName || !sku) {
    return { ok: false, error: "A variant name and SKU are required." };
  }

  const body = {
    sku,
    variant_name: variantName,
    attributes: attributeValue ? { flavor: attributeValue } : {},
    cost,
    case_quantity: Number(caseQty),
    pack_quantity: Number(packQty),
    barcodes: barcode ? [{ barcode, kind: "upc", is_primary: true }] : [],
  };

  try {
    const data = await apiFetch<CreatedVariant>(`/api/v1/catalog/products/${productId}/variants`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that variant." };
  }
}

export async function setPriceAction(
  productId: string,
  variantId: string,
  storeId: string | null,
  formData: FormData,
): Promise<ActionResult<{ price_minor: string }>> {
  const major = String(formData.get("price") ?? "").trim();
  const minor = parseMajorToMinor(major);
  if (minor === null) {
    return { ok: false, error: "Enter a valid price, like 24.99" };
  }

  try {
    await apiFetch(`/api/v1/catalog/variants/${variantId}/price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: minor, store_id: storeId }),
    });
    return { ok: true, data: { price_minor: minor } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not update the price." };
  }
}

/** A single-variant product. Multi-variant (several flavors of one item) isn't in this form yet. */
export async function createProductAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const name = String(formData.get("name") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const cost = String(formData.get("cost") ?? "").trim() || "0";
  const barcode = String(formData.get("barcode") ?? "").trim();
  const priceMajor = String(formData.get("price") ?? "").trim();
  const brandId = String(formData.get("brand_id") ?? "").trim();
  const categoryId = String(formData.get("category_id") ?? "").trim();
  const taxCategoryId = String(formData.get("tax_category_id") ?? "").trim();
  const storeId = String(formData.get("store_id") ?? "").trim();

  if (!name || !sku) {
    return { ok: false, error: "Name and SKU are required." };
  }

  const priceMinor = priceMajor ? parseMajorToMinor(priceMajor) : null;
  if (priceMajor && priceMinor === null) {
    return { ok: false, error: "Enter a valid price, like 24.99" };
  }

  let compliance: Record<string, unknown> | undefined;
  if (formData.get("age_restricted") === "on") {
    const minimumAge = String(formData.get("minimum_age") ?? "").trim();
    const regulatedClass = String(formData.get("regulated_class") ?? "").trim();
    compliance = {
      minimum_age: minimumAge ? Number(minimumAge) : null,
      id_scan_required: formData.get("id_scan_required") === "on",
      regulated_class: regulatedClass || null,
      contains_nicotine: formData.get("contains_nicotine") === "on",
      contains_cannabinoid: formData.get("contains_cannabinoid") === "on",
      is_smokable: formData.get("is_smokable") === "on",
    };
  }

  const body = {
    name,
    ...(brandId ? { brand_id: brandId } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(taxCategoryId ? { tax_category_id: taxCategoryId } : {}),
    ...(compliance ? { compliance } : {}),
    variants: [
      {
        sku,
        cost,
        case_quantity: 1,
        pack_quantity: 1,
        barcodes: barcode ? [{ barcode, kind: "upc", is_primary: true }] : [],
        ...(priceMinor ? { price_minor: priceMinor } : {}),
      },
    ],
  };

  try {
    const data = await apiFetch<{ id: string }>(
      `/api/v1/catalog/products${storeId ? `?store_id=${storeId}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create the product." };
  }
}

/**
 * A suggestion only -- the caller fills its own local state with the result;
 * nothing is written to the catalog here. "Create product" still has to be
 * clicked afterward for any of it to be saved.
 */
export async function suggestComplianceAction(name: string): Promise<ActionResult<AiComplianceSuggestion>> {
  if (!name.trim()) {
    return { ok: false, error: "Type a product name first." };
  }
  try {
    const data = await apiFetch<AiComplianceSuggestion>(`/api/v1/catalog/compliance/suggest`, {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not get an AI suggestion." };
  }
}

/** Each checkbox's value is "product_id:variant_id" -- one selection serves both bulk actions below, since the editable fields live on different rows of the same list. */
function splitRowKeys(formData: FormData): { productIds: string[]; variantIds: string[] } {
  const keys = formData.getAll("row_key").map(String);
  const productIds = [...new Set(keys.map((k) => k.split(":")[0]!))];
  const variantIds = keys.map((k) => k.split(":")[1]!);
  return { productIds, variantIds };
}

export async function bulkUpdateProductsAction(formData: FormData): Promise<ActionResult> {
  const { productIds } = splitRowKeys(formData);
  const categoryId = String(formData.get("bulk_category_id") ?? "").trim();
  const brandId = String(formData.get("bulk_brand_id") ?? "").trim();
  const taxCategoryId = String(formData.get("bulk_tax_category_id") ?? "").trim();
  const status = String(formData.get("bulk_status") ?? "").trim();

  if (productIds.length === 0) {
    return { ok: false, error: "Select at least one product first." };
  }
  if (!categoryId && !brandId && !taxCategoryId && !status) {
    return { ok: false, error: "Choose a field to change for the selected products." };
  }

  const body = {
    product_ids: productIds,
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(brandId ? { brand_id: brandId } : {}),
    ...(taxCategoryId ? { tax_category_id: taxCategoryId } : {}),
    ...(status ? { status } : {}),
  };

  try {
    await apiFetch(`/api/v1/catalog/products/bulk`, { method: "PATCH", body: JSON.stringify(body) });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not update those products." };
  }
}

export async function bulkSetPriceAction(formData: FormData): Promise<ActionResult> {
  const { variantIds } = splitRowKeys(formData);
  const priceMajor = String(formData.get("bulk_price") ?? "").trim();

  if (variantIds.length === 0) {
    return { ok: false, error: "Select at least one product first." };
  }
  const priceMinor = parseMajorToMinor(priceMajor);
  if (priceMinor === null) {
    return { ok: false, error: "Enter a valid price, like 24.99" };
  }

  const storeId = await primaryStoreId();

  try {
    await apiFetch(`/api/v1/catalog/variants/bulk-price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: priceMinor, variant_ids: variantIds, store_id: storeId }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not price those products." };
  }
}

/** The "traditional" way to add members to a price category -- from the same checkbox selection the other two bulk actions above already use. */
export async function addToPriceCategoryAction(formData: FormData): Promise<ActionResult> {
  const { variantIds } = splitRowKeys(formData);
  const categoryId = String(formData.get("target_price_category_id") ?? "").trim();

  if (variantIds.length === 0) {
    return { ok: false, error: "Select at least one product first." };
  }
  if (!categoryId) {
    return { ok: false, error: "Choose a price category first." };
  }

  try {
    await apiFetch(`/api/v1/catalog/price-categories/${categoryId}/members`, {
      method: "POST",
      body: JSON.stringify({ variant_ids: variantIds }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add those items to the category." };
  }
}

// -------------------------------------------------------------------------
// Price categories: unchanged, plain redirecting Server Actions. Those pages
// aren't converted to the client-interactivity pattern this pass -- see the
// plan's "deferred" list.
// -------------------------------------------------------------------------

export async function createPriceCategoryAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/catalog/price-categories/new?error=${encodeURIComponent("Give this category a name.")}`);
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(`/api/v1/catalog/price-categories`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create that category.";
    redirect(`/catalog/price-categories/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/catalog/price-categories/${created.id}?saved=1`);
}

export async function setPriceCategoryPriceAction(id: string, formData: FormData): Promise<void> {
  const priceMajor = String(formData.get("price") ?? "").trim();
  const priceMinor = parseMajorToMinor(priceMajor);
  if (priceMinor === null) {
    redirect(`/catalog/price-categories/${id}?error=${encodeURIComponent("Enter a valid price, like 24.99")}`);
  }

  const storeId = await primaryStoreId();

  try {
    await apiFetch(`/api/v1/catalog/variants/bulk-price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: priceMinor, price_group_id: id, store_id: storeId }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not price this category.";
    redirect(`/catalog/price-categories/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/price-categories/${id}?saved=1`);
}

export async function removePriceCategoryMemberAction(id: string, variantId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/catalog/price-categories/${id}/members/${variantId}/remove`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not remove that item.";
    redirect(`/catalog/price-categories/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/price-categories/${id}?saved=1`);
}

/** No-JS fallback for the speed-scan box -- a full round trip that still works with JavaScript disabled. */
export async function scanAddToPriceCategoryAction(id: string, formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) {
    redirect(`/catalog/price-categories/${id}`);
  }

  let match: { sku: string };
  try {
    match = await apiFetch<{ sku: string }>(`/api/v1/catalog/price-categories/${id}/scan`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that item.";
    redirect(`/catalog/price-categories/${id}?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/catalog/price-categories/${id}?justAdded=${encodeURIComponent(match.sku)}`);
}
