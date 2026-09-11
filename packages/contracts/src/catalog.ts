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
  kind: z.enum(['upc', 'ean', 'plu', 'itf14', 'custom']),
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
});

export const createProductSchema = z
  .object({
    name: z.string().min(1).max(256),
    short_name: z.string().max(64).optional(),
    description: z.string().max(4096).optional(),
    brand_id: uuid.optional(),
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
  .partial();

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

export type Category = z.infer<typeof categorySchema>;
export type Brand = z.infer<typeof brandSchema>;
export type Product = z.infer<typeof productSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type CreateProduct = z.infer<typeof createProductSchema>;
export type ProductSearch = z.infer<typeof productSearchSchema>;
