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

/**
 * Ask for a brand's logo to be found on the web. A brand that already has one
 * keeps it unless `replace` says otherwise, so an automatic find after an AI
 * draft never overwrites a logo somebody chose.
 */
export const findBrandLogoSchema = z.object({ replace: z.boolean().default(false) });

/** One row of the back office's Brands page. */
export const brandWithLogoSchema = z.object({
  id: uuid,
  name: z.string(),
  /** Serve with `GET /v1/catalog/brand-logos/:logo_id`. Null when the brand has none. */
  logo_id: uuid.nullable(),
  logo_source_url: z.string().nullable(),
  /** Products on sale under this brand. */
  product_count: z.number().int(),
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
 * AI fill: a draft of a whole product page, researched on the web and written
 * to the shop's house format (see `CatalogCopy` in the API). A draft only --
 * the product page fills its fields with it and nothing is stored until a
 * person presses Save.
 */
export const aiProductFillSchema = z.object({
  /** "{Brand} {Line} {Size or count}": "Backwoods Cigars 5pk". Never a flavour. */
  name: z.string(),
  /** At most 24 characters, for the receipt: "Backwoods 5pk". */
  short_name: z.string(),
  /** Sales copy for the website, plain text, a few short paragraphs. */
  description: z.string(),
  brand: z.string().nullable(),
  /** One of the shop's own category names, exactly, or null. */
  category: z.string().nullable(),
  /**
   * A category to add, when none of the shop's own fits: "Energy Drinks".
   * Only ever set when `category` is null.
   */
  new_category: z.string().nullable().optional(),
  /** The shop category the new one belongs under, exactly as the shop names it, or null for the top level. */
  new_category_parent: z.string().nullable().optional(),
  /** One of the shop's own tax category codes, exactly, or null. */
  tax_category_code: z.string().nullable(),
  tags: z.array(z.string()),
  /** What the variants differ by: flavor, size, color, strength. */
  variant_axis: z.string().nullable(),
  /** Every variant the product is actually sold in, flavour names only. */
  variants: z.array(z.string()),
  /**
   * The flavour the product's current name names, when it names one: items
   * imported one per flavour read "Celsius Sparkling Orange 12Oz". Spelled as
   * in `variants`. How the item already on the shelf is recognised.
   */
  current_flavor: z.string().nullable().optional(),
  compliance: productComplianceSchema,
  /** Pages the facts came from. */
  sources: z.array(z.string()),
});

/** The AI draft as the API returns it: names matched to the shop's own records. */
export const aiProductDraftSchema = aiProductFillSchema.omit({ variants: true }).extend({
  brand_id: uuid.nullable(),
  category_id: uuid.nullable(),
  /** `new_category_parent` matched to the shop's category, when there is one. */
  new_category_parent_id: uuid.nullable().optional(),
  tax_category_id: uuid.nullable(),
  variants: z.array(
    z.object({
      name: z.string(),
      /** Set when this product already has a variant by this name. */
      existing_variant_id: uuid.nullable(),
    }),
  ),
});

export const aiProductFillRequestSchema = z.object({
  /** Anything the person wants to steer by: "the 5 pack, not the single". */
  hint: z.string().max(500).optional(),
});

/**
 * Product photos to look for: one per variant name, plus the product itself.
 *
 * No cap on how many. A line like Foger's pods runs past eighty flavors, and
 * refusing the request outright helps nobody; the dashboard asks in batches
 * so no single model call has to carry them all.
 */
export const aiImageSearchRequestSchema = z.object({
  variants: z.array(z.string().min(1).max(128)).min(1),
});

export const aiImageCandidateSchema = z.object({
  /** Null for the product's own photo. */
  variant_name: z.string().nullable(),
  /** A direct image address when one was found. */
  image_url: z.string().nullable(),
  /** The page it is on, kept as the photo's source either way. */
  page_url: z.string().nullable(),
});

export const aiImageSearchResultSchema = z.object({
  images: z.array(aiImageCandidateSchema),
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
  /** The page a found photo was taken from. Null for photos someone uploaded themselves. */
  source_url: z.string().nullable().optional(),
  created_at: timestamp,
});

export const uploadProductImageSchema = z.object({
  /** One of these, not both: a photo belongs either to the product or to one of its variants. */
  product_id: uuid.optional(),
  variant_id: uuid.optional(),
  alt_text: z.string().max(256).optional(),
  source_url: z.string().url().max(2048).optional(),
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
    /**
     * A category by name, found or created: how an AI draft files a product
     * under a category the shop does not have yet. `category_id` wins when
     * both are given. `category_parent_id` places a created one.
     */
    category_name: z.string().min(1).max(128).optional(),
    category_parent_id: uuid.optional(),
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
 * The same case costs and price for every flavor of one product, in one go.
 * Flavors of one line nearly always share them: a case of any Celsius costs
 * the same and every can sells for the same. Only the fields given change;
 * each flavor keeps its own value for the rest. A price given is set the way
 * `setVariantPriceSchema` sets one, flavor by flavor, so each keeps its own
 * price history.
 */
export const applyToAllVariantsSchema = updateVariantSchema
  .pick({ case_quantity: true, case_cost: true, case_discount: true, case_rebate: true, default_margin: true })
  .extend({
    price_minor: moneyNonNegative.optional(),
    store_id: uuid.nullable().optional(),
  })
  .refine(
    (v) =>
      [v.case_quantity, v.case_cost, v.case_discount, v.case_rebate, v.default_margin, v.price_minor].some(
        (field) => field !== undefined,
      ),
    { message: 'nothing to apply: give at least one field' },
  );

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
 * `variant_ids` prices that selection and keeps it as a group (reusing one
 * that already holds exactly those variants). `price_group_id` reprices a
 * group that already exists, without having to re-select its members.
 * Exactly one of the two is how the request says which case it is. Either
 * way only those variants move: a variant in other groups too keeps them,
 * and its price is simply whatever was set last.
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
 * Adds every given variant to the group without touching price -- unlike
 * `bulkPriceVariantsSchema`, joining a group here is a separate, deliberate
 * act from repricing it later. A variant can be in any number of groups
 * (`price_group_members`, 0035), so adding it here never takes it out of
 * another one.
 */
export const addPriceCategoryMembersSchema = z.object({
  variant_ids: z.array(uuid).min(1).max(500),
});

/** One scanned code at a time -- resolved the same way a manually typed SKU is during invoice review. */
export const scanPriceCategoryMemberSchema = z.object({
  code: z.string().min(1).max(64),
  /** Which store's price to report back for the item scanned in. */
  store_id: uuid.nullable().optional(),
});

export const priceCategorySchema = z.object({
  id: uuid,
  name: z.string().nullable(),
  created_at: timestamp,
  /** The product whose flavors this group was made for, when an AI draft made it. */
  product_id: uuid.nullable().optional(),
  member_count: z.number().int(),
  /** Null when empty, or when current members don't all share one price. */
  current_price_minor: moneyNonNegative.nullable(),
  /** The price most members share. What "off the group price" is measured against. */
  common_price_minor: moneyNonNegative.nullable().optional(),
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
  /** When the current price was set, by whatever route. The latest one set is the one that counts. */
  price_since: timestamp.nullable().optional(),
  /** The other groups this variant is in. */
  also_in: z.array(z.object({ id: uuid, name: z.string().nullable() })).optional(),
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
  /**
   * This one list is allowed to be long.
   *
   * The shared default is 50 with a ceiling of 200, which is right for the
   * register: it asks for what a screen can show. The back office asks a
   * different question -- "show me my catalog" -- and a shop with 453
   * flavours was being handed the first 50 of them and told, by a null
   * cursor, that there were no more. Silently showing someone a third of
   * their inventory is worse than being slow.
   *
   * One row per flavour, so the ceiling is counted in flavours and not in
   * products. A few thousand is a large independent shop and still one
   * modest response.
   */
  limit: z.coerce.number().int().min(1).max(5000).default(500),
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
export type FindBrandLogo = z.infer<typeof findBrandLogoSchema>;
export type BrandWithLogo = z.infer<typeof brandWithLogoSchema>;
export type Product = z.infer<typeof productSchema>;
export type ProductImage = z.infer<typeof productImageSchema>;
export type UploadProductImage = z.infer<typeof uploadProductImageSchema>;
export type ReorderProductImages = z.infer<typeof reorderProductImagesSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type CreateProduct = z.infer<typeof createProductSchema>;
export type UpdateProduct = z.infer<typeof updateProductSchema>;
export type BulkUpdateProducts = z.infer<typeof bulkUpdateProductsSchema>;
export type UpdateVariant = z.infer<typeof updateVariantSchema>;
export type ApplyToAllVariants = z.infer<typeof applyToAllVariantsSchema>;
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
export type AiProductFill = z.infer<typeof aiProductFillSchema>;
export type AiProductDraft = z.infer<typeof aiProductDraftSchema>;
export type AiProductFillRequest = z.infer<typeof aiProductFillRequestSchema>;
export type AiImageSearchRequest = z.infer<typeof aiImageSearchRequestSchema>;
export type AiImageCandidate = z.infer<typeof aiImageCandidateSchema>;
export type AiImageSearchResult = z.infer<typeof aiImageSearchResultSchema>;
export type CreatePriceCategory = z.infer<typeof createPriceCategorySchema>;
export type UpdatePriceCategory = z.infer<typeof updatePriceCategorySchema>;
export type DeletePriceCategoryResult = z.infer<typeof deletePriceCategoryResultSchema>;
export type AddPriceCategoryMembers = z.infer<typeof addPriceCategoryMembersSchema>;
export type ScanPriceCategoryMember = z.infer<typeof scanPriceCategoryMemberSchema>;
export type PriceCategory = z.infer<typeof priceCategorySchema>;
export type PriceCategoryMember = z.infer<typeof priceCategoryMemberSchema>;
