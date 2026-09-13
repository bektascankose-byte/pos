"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { Product, Variant } from "@snappos/contracts";

interface CreatedVariant {
  id: string;
  sku: string;
}

export async function updateProductAction(id: string, formData: FormData): Promise<void> {
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
    await apiFetch<Product>(`/api/v1/catalog/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save changes.";
    redirect(`/catalog/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/${id}?saved=1`);
}

export async function updateVariantAction(
  productId: string,
  variantId: string,
  formData: FormData,
): Promise<void> {
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
    await apiFetch<Variant>(`/api/v1/catalog/variants/${variantId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save changes.";
    redirect(`/catalog/${productId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/${productId}?saved=1`);
}

export async function addVariantAction(productId: string, formData: FormData): Promise<void> {
  const variantName = String(formData.get("variant_name") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const attributeValue = String(formData.get("attribute_value") ?? "").trim();
  const cost = String(formData.get("cost") ?? "").trim() || "0";
  const barcode = String(formData.get("barcode") ?? "").trim();
  const caseQty = String(formData.get("case_quantity") ?? "").trim() || "1";
  const packQty = String(formData.get("pack_quantity") ?? "").trim() || "1";

  if (!variantName || !sku) {
    redirect(`/catalog/${productId}?error=${encodeURIComponent("A variant name and SKU are required.")}`);
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
    await apiFetch<CreatedVariant>(`/api/v1/catalog/products/${productId}/variants`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that variant.";
    redirect(`/catalog/${productId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/${productId}?saved=1`);
}

export async function setPriceAction(
  productId: string,
  variantId: string,
  storeId: string | null,
  formData: FormData,
): Promise<void> {
  const major = String(formData.get("price") ?? "").trim();
  const minor = parseMajorToMinor(major);
  if (minor === null) {
    redirect(`/catalog/${productId}?error=${encodeURIComponent("Enter a valid price, like 24.99")}`);
  }

  try {
    await apiFetch(`/api/v1/catalog/variants/${variantId}/price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: minor, store_id: storeId }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not update the price.";
    redirect(`/catalog/${productId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog/${productId}?saved=1`);
}

/** A single-variant product. Multi-variant (several flavors of one item) isn't in this form yet. */
export async function createProductAction(formData: FormData): Promise<void> {
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
    redirect(`/catalog/new?error=${encodeURIComponent("Name and SKU are required.")}`);
  }

  const priceMinor = priceMajor ? parseMajorToMinor(priceMajor) : null;
  if (priceMajor && priceMinor === null) {
    redirect(`/catalog/new?error=${encodeURIComponent("Enter a valid price, like 24.99")}`);
  }

  const body = {
    name,
    ...(brandId ? { brand_id: brandId } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(taxCategoryId ? { tax_category_id: taxCategoryId } : {}),
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

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(
      `/api/v1/catalog/products${storeId ? `?store_id=${storeId}` : ""}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create the product.";
    redirect(`/catalog/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/catalog/${created.id}?saved=1`);
}

/** Each checkbox's value is "product_id:variant_id" -- one selection serves both bulk actions below, since the editable fields live on different rows of the same list. */
function splitRowKeys(formData: FormData): { productIds: string[]; variantIds: string[] } {
  const keys = formData.getAll("row_key").map(String);
  const productIds = [...new Set(keys.map((k) => k.split(":")[0]!))];
  const variantIds = keys.map((k) => k.split(":")[1]!);
  return { productIds, variantIds };
}

export async function bulkUpdateProductsAction(formData: FormData): Promise<void> {
  const { productIds } = splitRowKeys(formData);
  const categoryId = String(formData.get("bulk_category_id") ?? "").trim();
  const brandId = String(formData.get("bulk_brand_id") ?? "").trim();
  const taxCategoryId = String(formData.get("bulk_tax_category_id") ?? "").trim();
  const status = String(formData.get("bulk_status") ?? "").trim();

  if (productIds.length === 0) {
    redirect(`/catalog?error=${encodeURIComponent("Select at least one product first.")}`);
  }
  if (!categoryId && !brandId && !taxCategoryId && !status) {
    redirect(`/catalog?error=${encodeURIComponent("Choose a field to change for the selected products.")}`);
  }

  const body = {
    product_ids: productIds,
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(brandId ? { brand_id: brandId } : {}),
    ...(taxCategoryId ? { tax_category_id: taxCategoryId } : {}),
    ...(status ? { status } : {}),
  };

  try {
    await apiFetch(`/api/v1/catalog/products/bulk`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not update those products.";
    redirect(`/catalog?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog?saved=1`);
}

export async function bulkSetPriceAction(formData: FormData): Promise<void> {
  const { variantIds } = splitRowKeys(formData);
  const priceMajor = String(formData.get("bulk_price") ?? "").trim();

  if (variantIds.length === 0) {
    redirect(`/catalog?error=${encodeURIComponent("Select at least one product first.")}`);
  }
  const priceMinor = parseMajorToMinor(priceMajor);
  if (priceMinor === null) {
    redirect(`/catalog?error=${encodeURIComponent("Enter a valid price, like 24.99")}`);
  }

  const storeId = await primaryStoreId();

  try {
    await apiFetch(`/api/v1/catalog/variants/bulk-price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: priceMinor, variant_ids: variantIds, store_id: storeId }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not price those products.";
    redirect(`/catalog?error=${encodeURIComponent(message)}`);
  }
  redirect(`/catalog?saved=1`);
}
