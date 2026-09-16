/**
 * Catalog contracts.
 *
 * The shape here follows the schema's fourth rule: everything sellable is a
 * variant, including a product with exactly one. Barcodes, cost, price and
 * stock live on the variant and never on the product. A client that wants "the
 * price of a product" is asking the wrong question, and these types make that
 * difficult to express by accident.
 */

import { z } from 'zod';
import {
  uuid,
  slug,
  sku,
  barcode,
  costDecimal,
  moneyNonNegative,
  quantity,
  entityStatus,
  timestamp,
  pagination,
} from './primitives.js';

// ---------------------------------------------------------------- categories

export const categorySchema = z.object({
  id: uuid,
  parent_id: uuid.nullable(),
  slug,
  name: z.string().min(1).max(128),
  /**
   * Materialized path, dot delimited: `vapes.disposable.geek-bar`. Derived from
   * the parent by the API, never sent by a client. Depth is derived from it.
   */
  path: z.string(),
  depth: z.number().int().min(0),
  sort_order: z.number().int(),
  tile_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  image_url: z.string().url().nullable(),
  is_department: z.boolean(),
  status: entityStatus,
});

export const createCategorySchema = z.object({
  parent_id: uuid.nullable().optional(),
  slug,
  name: z.string().min(1).max(128),
  sort_order: z.number().int().default(0),
  tile_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  is_department: z.boolean().default(false),
});

/** Moving a category rewrites the path of every descendant. */
export const moveCategorySchema = z.object({ parent_id: uuid.nullable() });

// -------------------------------------------------------------------- brands

export const brandSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(128),
  brand_family: z.string().max(128).nullable(),
  logo_url: z.string().url().nullable(),
  status: entityStatus,
});

export const createBrandSchema = brandSchema.pick({ name: true }).extend({
  brand_family: z.string().max(128).optional(),
  logo_url: z.string().url().optional(),
});

// ------------------------------------------------------------------ barcodes

export const barcodeSchema = z.object({
  id: uuid,
  variant_id: uuid,
  barcode,
  /**
   * `case` is a carton/case code: the same item, scanned by the box it ships
   * in, which is what makes `units` below more than 1. The rest describe the
   * code's own symbology. Matches the `variant_barcodes.kind` column's own
   * documented vocabulary.
   */
  kind: z.enum(['upc', 'ean', 'plu', 'itf14', 'case', 'custom']),
  /**
   * How many sellable units one scan represents. A scanned case of 10 adds 10
   * units, which is why this belongs on the barcode and not on the variant.
   */
  units: quantity.default('1'),
  is_primary: z.boolean(),
});

export const createBarcodeSchema = barcodeSchema.omit({ id: true, variant_id: true }).partial({
  kind: true,
  units: true,
  is_primary: true,
});

/** Mirrors the `price_kind` Postgres enum. Only `regular` is written today; the rest exist for scheduled and reference prices. */
export const priceKind = z.enum(['regular', 'sale', 'map', 'msrp', 'cost_plus']);

/**
 * One past or present price for a variant. `variant_prices` is already
 * effective-dated -- a price change closes the open row and opens a new one
 * rather than editing in place -- so the history is simply that table read
 * back in order, no extra bookkeeping.
 */
export const variantPriceHistoryRowSchema = z.object({
  id: uuid,
  store_id: uuid.nullable(),
  kind: priceKind,
  price_minor: moneyNonNegative,
  effective_from: timestamp,
  effective_to: timestamp.nullable(),
  changed_by: z.string().nullable(),
});

// ------------------------------------------------------------------ variants

export const variantSchema = z.object({
  id: uuid,
  product_id: uuid,
  sku,
  plu: z.string().max(16).nullable(),
  variant_name: z.string().max(128).nullable(),
  /** Axis values: `{ "flavor": "Miami Mint", "strength": "5%" }`. */
  attributes: z.record(z.string()),
  is_default: z.boolean(),
  sort_order: z.number().int(),
  cost: costDecimal,
  average_cost: costDecimal,
  last_cost: costDecimal.nullable(),
  case_quantity: z.number().int().min(1),
  pack_quantity: z.number().int().min(1),
  /**
   * What the vendor charges for a case, and what comes off it. `cost` above is
   * derived from these when `case_cost` is set -- see
   * `CatalogService.updateVariant`. A rebate deliberately isn't part of that
   * derivation: it lands after the fact and belongs in "margin after rebate"
   * rather than in the cost inventory is valued at.
   */
  case_cost: costDecimal.nullable(),
  case_discount: costDecimal,
  case_rebate: costDecimal,
  /** Target margin percentage, for suggesting a retail price. */
  default_margin: z.string().nullable(),
  reorder_point: quantity.nullable(),
  reorder_quantity: quantity.nullable(),
  status: entityStatus,
  barcodes: z.array(barcodeSchema).optional(),
  /** Effective price for the requested store. Absent means not priced there. */
  price_minor: moneyNonNegative.optional(),
  /** Stock at the requested store. Absent when no store was specified. */
  on_hand: quantity.optional(),
  available: quantity.optional(),
});

export const createVariantSchema = z.object({
  sku,
  variant_name: z.string().max(128).optional(),
  attributes: z.record(z.string()).default({}),
  cost: costDecimal.default('0'),
  case_quantity: z.number().int().min(1).default(1),
  pack_quantity: z.number().int().min(1).default(1),
  reorder_point: quantity.optional(),
  reorder_quantity: quantity.optional(),
  barcodes: z.array(createBarcodeSchema).default([]),
  /** Opening price for the store this is created against. */
  price_minor: moneyNonNegative.optional(),
});

// ------------------------------------------------------------------ products

/**
 * Compliance lives on the product, not the variant, because every flavor of a
 * disposable vape carries the same statutory age. The register reads this to
 * decide whether to prompt, and the storefront reads it to decide whether a SKU
 * may be listed at all.
 */
export const productComplianceSchema = z.object({
  minimum_age: z.number().int().min(0).max(120).nullable(),
  id_scan_required: z.boolean(),
  regulated_class: z.string().max(64).nullable(),
  contains_nicotine: z.boolean(),
  contains_cannabinoid: z.boolean(),
  is_smokable: z.boolean(),
});

/**
 * A suggestion only -- see `AiService.classifyCompliance`. Nothing writes this
 * straight into `product_compliance`; a human reviews it on the create-product
 * form and the fields they actually submit (edited or not) are what's saved.
 */
export const aiComplianceSuggestionSchema = z.object({
  is_age_restricted: z.boolean(),
  minimum_age: z.number().int().min(0).max(120).nullable(),
  id_scan_required: z.boolean(),
  regulated_class: z.string().nullable(),
  contains_nicotine: z.boolean(),
  contains_cannabinoid: z.boolean(),
  is_smokable: z.boolean(),
  confidence: z.number(),
});

export const suggestComplianceSchema = z.object({
  name: z.string().min(1).max(256),
  brand: z.string().max(128).optional(),
  category: z.string().max(128).optional(),
  description: z.string().max(4096).optional(),
});

/**
 * A suggestion only -- see `AiService.suggestProductVariants`. Real-world
 * flavor/size names for a product, found via web search, offered as a
 * checklist a human picks from; nothing here creates a variant by itself.
 */
export const productVariantSuggestionSchema = z.object({
  variants: z.array(z.string()),
});

export const suggestVariantsSchema = z.object({
  product_name: z.string().min(1).max(256),
  brand_name: z.string().max(128).optional(),
});

/**
 * A photo of a product, or of one specific variant of it.
 *
 * `url` and `thumb_url` are **storage keys, not addresses** — the bucket is
 * private, so the bytes come back through `GET catalog/images/:id`, which
 * checks the caller the same way every other read does. A public or presigned
 * URL would either leak the catalog or expire out from under a register that
 * has been offline since Tuesday.
 *
 * Attached to a variant when the flavours look different and to the product
 * when they don't, which is why exactly one of the two ids is set.
 */
export const productImageSchema = z.object({
  id: uuid,
  product_id: uuid.nullable(),
  variant_id: uuid.nullable(),
  alt_text: z.string().nullable(),
  sort_order: z.number().int(),
  /** True for the image a list or a register tile should show. The lowest sort_order wins. */
  is_primary: z.boolean(),
  created_at: timestamp,
});

export const uploadProductImageSchema = z.object({
  /** One of these, not both: a photo belongs either to the product or to one of its variants. */
  product_id: uuid.optional(),
  variant_id: uuid.optional(),
  alt_text: z.string().max(256).optional(),
});

export const reorderProductImagesSchema = z.object({
  /** Image ids in the order they should appear. The first becomes the primary. */
  image_ids: z.array(uuid).min(1).max(24),
});

export const productSchema = z.object({
  id: uuid,
  name: z.string().min(1).max(256),
  short_name: z.string().max(64).nullable(),
  description: z.string().max(4096).nullable(),
  brand_id: uuid.nullable(),
  category_id: uuid.nullable(),
  tax_category_id: uuid.nullable(),
  unit_type: z.string().max(32),
  has_variants: z.boolean(),
  variant_axes: z.array(z.string()),
  image_url: z.string().url().nullable(),
  tags: z.array(z.string()),
  status: entityStatus,
  created_at: timestamp,
  updated_at: timestamp,
  compliance: productComplianceSchema.nullable().optional(),
  variants: z.array(variantSchema).optional(),
  images: z.array(productImageSchema).optional(),
});

export const createProductSchema = z
  .object({
    name: z.string().min(1).max(256),
    short_name: z.string().max(64).optional(),
    description: z.string().max(4096).optional(),
    brand_id: uuid.optional(),
    /** A brand typed as free text rather than picked from the existing list -- created automatically if it doesn't already exist. Ignored when `brand_id` is also given. */
    brand_name: z.string().max(128).optional(),
    category_id: uuid.optional(),
    tax_category_id: uuid.optional(),
    unit_type: z.string().max(32).default('each'),
    variant_axes: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    compliance: productComplianceSchema.partial().optional(),
    /**
     * At least one. A product with no variant is not sellable, so the API
     * creates the implicit single variant rather than letting a client forget.
     */
    variants: z.array(createVariantSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const skus = v.variants.map((x) => x.sku);
    if (new Set(skus).size !== skus.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants'], message: 'duplicate SKU' });
    }
    // A multi-variant product must declare its axes, otherwise the register has
    // no idea how to group four flavors under one tile.
    if (v.variants.length > 1 && v.variant_axes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variant_axes'],
        message: 'a product with several variants must declare at least one axis (e.g. flavor)',
      });
    }
  });

export const updateProductSchema = createProductSchema
  .innerType()
  .omit({ variants: true })
  .partial()
  .extend({
    /**
     * Archiving is how a product is removed. Sale lines, purchase orders and
     * invoice lines all reference a variant, so deleting the row would either
     * break that history or drag it along; an archived product disappears from
     * the catalog, search and the register instead, and can be restored.
     */
    status: entityStatus.optional(),
  });

/** Applied to every product_id in the list, in one transaction. At least one field besides the id list is required -- a bulk update that changes nothing is a mistake, not a no-op worth allowing. */
export const bulkUpdateProductsSchema = z
  .object({
    product_ids: z.array(uuid).min(1).max(500),
    category_id: uuid.optional(),
    brand_id: uuid.optional(),
    tax_category_id: uuid.optional(),
    status: entityStatus.optional(),
  })
  .refine((v) => v.category_id || v.brand_id || v.tax_category_id || v.status, {
    message: 'at least one field to change is required',
  });

/**
 * Editing an existing variant. Deliberately excludes price and barcodes:
 * price is its own event (see `setVariantPriceSchema` -- a variant's price
 * is a history, not a field to overwrite) and barcodes are their own
 * sub-resource. `sku` is also excluded -- it is what the register's own
 * receipts and reports already reference a sale line by, and changing it
 * out from under existing history is a different, much more dangerous
 * operation than this endpoint is for.
 */
export const updateVariantSchema = z.object({
  variant_name: z.string().max(128).optional(),
  /** Short keypad code for items rung up without a barcode. */
  plu: z.string().max(16).optional(),
  /** Ignored when this variant has a `case_cost`, which `cost` is derived from instead. */
  cost: costDecimal.optional(),
  case_quantity: z.number().int().min(1).optional(),
  pack_quantity: z.number().int().min(1).optional(),
  case_cost: costDecimal.optional(),
  case_discount: costDecimal.optional(),
  case_rebate: costDecimal.optional(),
  default_margin: z
    .string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'a margin percentage below 100, like 32.5')
    .optional(),
  reorder_point: quantity.optional(),
  reorder_quantity: quantity.optional(),
  status: entityStatus.optional(),
});

/**
 * Changing what a variant sells for. This always inserts a new
 * `variant_prices` row and closes out whatever was open before it -- see
 * `CatalogService.setVariantPrice` -- because the schema's own
 * `variant_prices_open_regular_key` models price as a history, not a
 * mutable field, and a plain UPDATE would erase the fact that a different
 * price ever existed.
 */
export const setVariantPriceSchema = z.object({
  price_minor: moneyNonNegative,
  /** Omitted (or explicitly null) means the org-wide default price. */
  store_id: uuid.nullable().optional(),
});

/**
 * Price several variants together, in one transaction.
 *
 * `variant_ids` mints a fresh price group and stamps it on every variant
 * given -- a group is formed by pricing, not declared ahead of time.
 * `price_group_id` reprices a group that already exists, without having to
 * re-select its members. Exactly one of the two is how the request says
 * which case it is.
 */
export const bulkPriceVariantsSchema = z
  .object({
    price_minor: moneyNonNegative,
    /** Omitted (or explicitly null) means the org-wide default price, same as `setVariantPriceSchema`. */
    store_id: uuid.nullable().optional(),
    variant_ids: z.array(uuid).min(1).max(500).optional(),
    price_group_id: uuid.optional(),
  })
  .refine((v) => (v.variant_ids ? 1 : 0) + (v.price_group_id ? 1 : 0) === 1, {
    message: 'give either variant_ids (to form or reprice a specific set) or price_group_id, not both',
  });

/**
 * A named `price_groups` row, declared ahead of time rather than formed
 * incidentally by `bulkSetPrice` -- so a manager can build its membership over
 * one or more sessions before ever setting a price. Reuses the same table and
 * `product.update` gate `bulkSetPrice` already sits behind.
 */
export const createPriceCategorySchema = z.object({ name: z.string().min(1).max(128) });

/**
 * Rename a price group.
 *
 * Only the name: the group's *price* is changed by repricing its members
 * (`bulkPriceVariantsSchema`), which is a different act with different
 * consequences — one relabels a folder, the other changes what customers pay.
 * Keeping them apart is why a group has no price column of its own.
 */
export const updatePriceCategorySchema = z.object({ name: z.string().min(1).max(128) });

/**
 * What dissolving a group did.
 *
 * Deleting a price group releases its members and destroys nothing else:
 * the items, their prices and their history all stay exactly as they are.
 * A group is a saved grouping, not a thing anyone sells. `released` is how
 * many items came out of it, so the confirmation can say so plainly rather
 * than leaving someone wondering what they just did to their catalog.
 */
export const deletePriceCategoryResultSchema = z.object({
  deleted: z.boolean(),
  released: z.number().int(),
});

/**
 * Stamps `price_group_id` on every given variant without touching price --
 * unlike `bulkPriceVariantsSchema`, forming/joining a category here is a
 * separate, deliberate act from repricing it later. A variant carries at most
 * one price category at a time (a plain FK column, not a join table), so
 * adding it here silently moves it out of whatever category it was in.
 */
export const addPriceCategoryMembersSchema = z.object({
  variant_ids: z.array(uuid).min(1).max(500),
});

/** One scanned code at a time -- resolved the same way a manually typed SKU is during invoice review. */
export const scanPriceCategoryMemberSchema = z.object({ code: z.string().min(1).max(64) });

export const priceCategorySchema = z.object({
  id: uuid,
  name: z.string().nullable(),
  created_at: timestamp,
  member_count: z.number().int(),
  /** Null when empty, or when current members don't all share one price. */
  current_price_minor: moneyNonNegative.nullable(),
  /**
   * Members that have drifted off the price the rest of the group shares --
   * the whole reason to group prices in the first place. An unpriced member
   * counts, being just as wrong at the counter as a differently-priced one.
   */
  mismatch_count: z.number().int(),
});

export const priceCategoryMemberSchema = z.object({
  variant_id: uuid,
  product_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  sku,
  price_minor: moneyNonNegative.nullable(),
});

export const taxCategorySchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

// -------------------------------------------------------------------- search

export const productSearchSchema = pagination.extend({
  q: z.string().max(128).optional(),
  store_id: uuid.optional(),
  category_id: uuid.optional(),
  brand_id: uuid.optional(),
  status: entityStatus.optional(),
  /** Only variants with stock. The register's default view. */
  in_stock: z.coerce.boolean().optional(),
});

/** Barcode lookup is the single hottest path in the system. */
export const scanSchema = z.object({ barcode, store_id: uuid });

export type PriceKind = z.infer<typeof priceKind>;
export type VariantPriceHistoryRow = z.infer<typeof variantPriceHistoryRowSchema>;
export type Barcode = z.infer<typeof barcodeSchema>;
export type CreateBarcode = z.infer<typeof createBarcodeSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Brand = z.infer<typeof brandSchema>;
export type CreateBrand = z.infer<typeof createBrandSchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductImage = z.infer<typeof productImageSchema>;
export type UploadProductImage = z.infer<typeof uploadProductImageSchema>;
export type ReorderProductImages = z.infer<typeof reorderProductImagesSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type CreateProduct = z.infer<typeof createProductSchema>;
export type UpdateProduct = z.infer<typeof updateProductSchema>;
export type BulkUpdateProducts = z.infer<typeof bulkUpdateProductsSchema>;
export type UpdateVariant = z.infer<typeof updateVariantSchema>;
export type SetVariantPrice = z.infer<typeof setVariantPriceSchema>;
export type BulkPriceVariants = z.infer<typeof bulkPriceVariantsSchema>;
export type CreateVariant = z.infer<typeof createVariantSchema>;
export type TaxCategory = z.infer<typeof taxCategorySchema>;
export type ProductSearch = z.infer<typeof productSearchSchema>;
export type ProductCompliance = z.infer<typeof productComplianceSchema>;
export type AiComplianceSuggestion = z.infer<typeof aiComplianceSuggestionSchema>;
export type SuggestCompliance = z.infer<typeof suggestComplianceSchema>;
export type ProductVariantSuggestion = z.infer<typeof productVariantSuggestionSchema>;
export type SuggestVariants = z.infer<typeof suggestVariantsSchema>;
export type CreatePriceCategory = z.infer<typeof createPriceCategorySchema>;
export type UpdatePriceCategory = z.infer<typeof updatePriceCategorySchema>;
export type DeletePriceCategoryResult = z.infer<typeof deletePriceCategoryResultSchema>;
export type AddPriceCategoryMembers = z.infer<typeof addPriceCategoryMembersSchema>;
export type ScanPriceCategoryMember = z.infer<typeof scanPriceCategoryMemberSchema>;
export type PriceCategory = z.infer<typeof priceCategorySchema>;
export type PriceCategoryMember = z.infer<typeof priceCategoryMemberSchema>;
