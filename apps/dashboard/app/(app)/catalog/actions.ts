"use server";

import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import { primaryStoreId } from "@/lib/store";
import type { ActionResult } from "@/lib/action-result";
import type {
  Product,
  Variant,
  AiComplianceSuggestion,
  ProductVariantSuggestion,
  LedgerEntry,
} from "@snappos/contracts";

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

/**
 * Archive rather than delete. Sale lines, purchase orders and invoice lines
 * all point at this product's variants; removing the row would either break
 * that history or take it with it. Archiving hides it from the catalog,
 * search and the register, and is reversible.
 */
export async function setProductStatusAction(
  id: string,
  status: "active" | "archived",
): Promise<ActionResult<Product>> {
  try {
    const data = await apiFetch<Product>(`/api/v1/catalog/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not change that item's status." };
  }
}

/**
 * Age restriction and the rest of the compliance record. Until now these were
 * only settable when a product was first created (from the AI suggestion on
 * the new-item form), so a wrong or missing age restriction couldn't be
 * corrected afterwards.
 */
export async function updateComplianceAction(
  productId: string,
  formData: FormData,
): Promise<ActionResult<Product>> {
  const minimumAge = String(formData.get("minimum_age") ?? "").trim();
  const regulatedClass = String(formData.get("regulated_class") ?? "").trim();

  const compliance = {
    minimum_age: minimumAge ? Number(minimumAge) : null,
    id_scan_required: formData.get("id_scan_required") === "on",
    regulated_class: regulatedClass || null,
    contains_nicotine: formData.get("contains_nicotine") === "on",
    contains_cannabinoid: formData.get("contains_cannabinoid") === "on",
    is_smokable: formData.get("is_smokable") === "on",
  };

  try {
    const data = await apiFetch<Product>(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      body: JSON.stringify({ compliance }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save compliance." };
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
  const plu = String(formData.get("plu") ?? "").trim();
  if (plu) body.plu = plu;
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
  for (const field of ["case_cost", "case_discount", "case_rebate", "default_margin"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }

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

/**
 * Web-search-backed suggestions of a real product's known flavor/size
 * variants -- a checklist the caller renders; nothing is created here.
 */
export async function suggestVariantsAction(
  productName: string,
  brandName?: string,
): Promise<ActionResult<ProductVariantSuggestion>> {
  if (!productName.trim()) {
    return { ok: false, error: "Type a product name first." };
  }
  try {
    const data = await apiFetch<ProductVariantSuggestion>(`/api/v1/catalog/variants/suggest`, {
      method: "POST",
      body: JSON.stringify({
        product_name: productName.trim(),
        ...(brandName?.trim() ? { brand_name: brandName.trim() } : {}),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not get AI variant suggestions." };
  }
}

/**
 * `price_minor` is typed loosely here on purpose: the contract's own type
 * brands it as `Money`, because that schema is shared with request validation,
 * but this response is the plain digit string the API sends and was never
 * parsed through it.
 */
export interface PriceHistoryRow {
  id: string;
  store_id: string | null;
  kind: string;
  price_minor: string;
  effective_from: string;
  effective_to: string | null;
  changed_by: string | null;
}

/** Re-read one product after something about it changed -- a code added, a variant edited. */
export async function getProductAction(
  productId: string,
  storeId: string | null,
): Promise<ActionResult<Product>> {
  try {
    const data = await apiFetch<Product>(
      `/api/v1/catalog/products/${productId}${storeId ? `?store_id=${storeId}` : ""}`,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not reload that item." };
  }
}

export async function getPriceHistoryAction(variantId: string): Promise<ActionResult<PriceHistoryRow[]>> {
  try {
    const data = await apiFetch<PriceHistoryRow[]>(
      `/api/v1/catalog/variants/${variantId}/price-history`,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not load price history." };
  }
}

/**
 * Every stock movement for one variant, newest first. Purchases and sales are
 * both in here already -- they're the same ledger with different `reason`s --
 * so the item page filters this one read rather than asking twice.
 */
export async function getVariantMovementsAction(
  variantId: string,
): Promise<ActionResult<LedgerEntry[]>> {
  try {
    const data = await apiFetch<LedgerEntry[]>(
      `/api/v1/inventory/ledger?variant_id=${variantId}&limit=100`,
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not load item history." };
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

export async function createPriceCategoryAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { ok: false, error: "Give this category a name." };
  }

  try {
    const data = await apiFetch<{ id: string }>(`/api/v1/catalog/price-categories`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create that category." };
  }
}

export async function setPriceCategoryPriceAction(id: string, formData: FormData): Promise<ActionResult> {
  const priceMajor = String(formData.get("price") ?? "").trim();
  const priceMinor = parseMajorToMinor(priceMajor);
  if (priceMinor === null) {
    return { ok: false, error: "Enter a valid price, like 24.99" };
  }

  const storeId = await primaryStoreId();

  try {
    await apiFetch(`/api/v1/catalog/variants/bulk-price`, {
      method: "POST",
      body: JSON.stringify({ price_minor: priceMinor, price_group_id: id, store_id: storeId }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not price this category." };
  }
}

export async function removePriceCategoryMemberAction(id: string, variantId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/catalog/price-categories/${id}/members/${variantId}/remove`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that item." };
  }
}

interface ScannedMember {
  variant_id: string;
  product_name: string;
  variant_name: string | null;
  sku: string;
}

export async function scanAddToPriceCategoryAction(id: string, code: string): Promise<ActionResult<ScannedMember>> {
  if (!code.trim()) {
    return { ok: false, error: "Type or scan a code first." };
  }
  try {
    const data = await apiFetch<ScannedMember>(`/api/v1/catalog/price-categories/${id}/scan`, {
      method: "POST",
      body: JSON.stringify({ code: code.trim() }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that item." };
  }
}

/**
 * Create a category, brand or price group from wherever someone happens to be
 * standing.
 *
 * The three collapse into one action because they are the same shape from the
 * caller's side — a name in, a `{ id, name }` back to drop into a dropdown —
 * and because the alternative is three near-identical functions and three
 * near-identical modals. The API endpoints stay separate, as they should.
 */
export async function createLookupAction(
  kind: "category" | "brand" | "price_group",
  name: string,
): Promise<ActionResult<{ id: string; name: string }>> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Give it a name first." };

  const path =
    kind === "category"
      ? "/api/v1/catalog/categories"
      : kind === "brand"
        ? "/api/v1/catalog/brands"
        : "/api/v1/catalog/price-categories";

  // A category needs a URL-safe slug as well as a name, and nobody creating
  // "Disposable Vapes" from a dropdown should be asked to invent one. Derived
  // to match the contract's own rule: lowercase, digits and hyphens, starting
  // with an alphanumeric. A name with nothing usable in it at all (say, all
  // punctuation) falls back to a timestamp rather than sending an empty slug
  // the API would reject with a message about a field the form never showed.
  const body: Record<string, unknown> =
    kind === "category" ? { name: trimmed, slug: slugify(trimmed) } : { name: trimmed };

  try {
    const data = await apiFetch<{ id: string; name?: string | null }>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // A price group's own `name` is nullable in the contract, so the name
    // that was just typed is the reliable label for the new option.
    return { ok: true, data: { id: data.id, name: data.name ?? trimmed } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : `Could not create that ${kind.replace("_", " ")}.` };
  }
}

/**
 * Edit one row of the catalog list, in place.
 *
 * Deliberately orchestrates three endpoints rather than adding a fourth that
 * does all of it: the name and category live on the product, the SKU and cost
 * on the variant, and a price change has to go through the effective-dated
 * price endpoint so it lands in the item's history like any other. A combined
 * endpoint would be a second way to change a price, which is exactly how one
 * of them stops recording history.
 *
 * Each call is attempted regardless of whether the previous failed, and every
 * failure is collected — telling someone "the price saved but the SKU didn't"
 * is worth more than stopping at the first problem and leaving them guessing
 * which half applied.
 */
export async function quickEditRowAction(
  productId: string,
  variantId: string,
  formData: FormData,
): Promise<ActionResult> {
  const value = (key: string): string => String(formData.get(key) ?? "").trim();
  const problems: string[] = [];

  const productBody: Record<string, unknown> = {};
  if (value("product_name")) productBody.name = value("product_name");
  if (value("category_id")) productBody.category_id = value("category_id");
  if (value("brand_id")) productBody.brand_id = value("brand_id");

  if (Object.keys(productBody).length > 0) {
    try {
      await apiFetch(`/api/v1/catalog/products/${productId}`, {
        method: "PATCH",
        body: JSON.stringify(productBody),
      });
    } catch (e) {
      problems.push(e instanceof ApiError ? e.message : "the product details");
    }
  }

  const variantBody: Record<string, unknown> = {};
  for (const field of ["sku", "variant_name", "plu", "cost"] as const) {
    if (value(field)) variantBody[field] = value(field);
  }
  if (Object.keys(variantBody).length > 0) {
    try {
      await apiFetch(`/api/v1/catalog/variants/${variantId}`, {
        method: "PATCH",
        body: JSON.stringify(variantBody),
      });
    } catch (e) {
      problems.push(e instanceof ApiError ? e.message : "the item details");
    }
  }

  const price = parseMajorToMinor(value("price"));
  if (value("price") && price === null) {
    problems.push(`"${value("price")}" isn't a price`);
  } else if (price !== null) {
    try {
      await apiFetch(`/api/v1/catalog/variants/${variantId}/price`, {
        method: "POST",
        body: JSON.stringify({ price_minor: price, store_id: await primaryStoreId() }),
      });
    } catch (e) {
      problems.push(e instanceof ApiError ? e.message : "the price");
    }
  }

  if (problems.length > 0) return { ok: false, error: problems.join("; ") };
  return { ok: true, data: undefined };
}

/**
 * Archive one item from the list.
 *
 * The variant, not the product: a list row is one sellable thing, and
 * archiving a whole product because somebody retired one flavour of it would
 * take the other flavours with it. Archiving never deletes — sale lines,
 * purchase orders and invoice lines all point at this row.
 */
export async function archiveVariantAction(variantId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/catalog/variants/${variantId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not archive that item." };
  }
}

/** A display name to the URL-safe slug `createCategorySchema` requires: lowercase, digits, hyphens, alphanumeric first. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || `category-${Date.now()}`;
}
