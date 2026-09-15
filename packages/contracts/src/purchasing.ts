/**
 * Purchasing contracts: vendors, purchase orders, and receiving.
 *
 * Receiving never sets stock directly -- it posts `receiving` movements
 * through the same inventory ledger every other stock change goes through
 * (see inventory.ts). A purchase order's own totals are what was *ordered*
 * and do not change when what actually arrives differs; that difference is
 * what `variance_flagged`/`variance_note` on the receipt exist to record,
 * not something silently absorbed into the PO.
 */

import { z } from 'zod';
import {
  uuid,
  timestamp,
  quantity,
  costDecimal,
  phone,
  email,
  entityStatus,
  moneyNonNegative,
} from './primitives.js';

/**
 * The whole vendor record, not the nine columns the list endpoint used to
 * return. A vendor is who to call when a case arrives short, so the sales rep
 * and the terms matter as much as the name.
 *
 * `edi_config` is deliberately absent: it holds per-partner integration
 * settings keyed to a credential reference, and there is no UI that should be
 * free-typing into it. Read it from the database when EDI is actually built.
 */
export const vendorSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  contact_name: z.string().nullable(),
  sales_rep_name: z.string().nullable(),
  sales_rep_phone: z.string().nullable(),
  sales_rep_email: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string(),
  payment_terms: z.string().nullable(),
  lead_time_days: z.number().int().nonnegative(),
  minimum_order_minor: z.string(),
  free_shipping_threshold_minor: z.string().nullable(),
  edi_enabled: z.boolean(),
  notes: z.string().nullable(),
  status: entityStatus,
  created_at: timestamp,
});

/**
 * A row in the vendor list: the record plus the three numbers that say
 * whether this vendor is actually being bought from -- how many catalog items
 * carry their SKU, when their last invoice landed, and what's on order now.
 */
export const vendorListRowSchema = vendorSchema.extend({
  item_count: z.number().int(),
  last_invoice_at: timestamp.nullable(),
  open_po_count: z.number().int(),
});

/** One catalog item this vendor sells, as `vendor_variants` records it. */
export const vendorItemSchema = z.object({
  id: uuid,
  variant_id: uuid,
  product_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  sku: z.string(),
  vendor_sku: z.string(),
  vendor_barcode: z.string().nullable(),
  case_quantity: z.number().int(),
  case_cost: costDecimal,
  unit_cost: costDecimal,
  is_preferred: z.boolean(),
  last_ordered_at: timestamp.nullable(),
});

/** One of this vendor's invoices, for the detail page's history list. */
export const vendorInvoiceSchema = z.object({
  id: uuid,
  source_filename: z.string(),
  vendor_invoice_no: z.string().nullable(),
  invoice_total_minor: z.string().nullable(),
  status: z.string(),
  line_count: z.number().int(),
  created_at: timestamp,
  committed_at: timestamp.nullable(),
});

export const vendorDetailSchema = vendorListRowSchema.extend({
  items: z.array(vendorItemSchema),
  invoices: z.array(vendorInvoiceSchema),
  purchase_orders: z.array(
    z.object({
      id: uuid,
      reference: z.string(),
      status: z.string(),
      total_minor: z.string(),
      created_at: timestamp,
    }),
  ),
});

/**
 * Everything about a vendor a person can type. Spelled out rather than
 * derived from `vendorSchema`, because what's stored and what's writable
 * differ: `id`/`created_at` are the server's, and `edi_config` is nobody's to
 * free-type into.
 */
export const createVendorSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(256),
  contact_name: z.string().max(256).optional(),
  sales_rep_name: z.string().max(256).optional(),
  sales_rep_phone: phone.optional(),
  sales_rep_email: email.optional(),
  phone: phone.optional(),
  email: email.optional(),
  website: z.string().max(512).optional(),
  address_line1: z.string().max(256).optional(),
  address_line2: z.string().max(256).optional(),
  city: z.string().max(128).optional(),
  region: z.string().max(128).optional(),
  postal_code: z.string().max(32).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  payment_terms: z.string().max(32).optional(),
  lead_time_days: z.number().int().nonnegative().max(365).optional(),
  minimum_order_minor: moneyNonNegative.optional(),
  free_shipping_threshold_minor: moneyNonNegative.optional(),
  notes: z.string().max(4000).optional(),
});

/**
 * Every field optional, `COALESCE`-style: an omitted field keeps whatever the
 * row already holds rather than clearing it, the same rule
 * `updateCustomerSchema` follows. `status` is here so archiving is an edit
 * rather than a separate verb -- there is no vendor delete, since purchase
 * orders, receipts and `vendor_variants` all point back at this row.
 */
export const updateVendorSchema = createVendorSchema.partial().extend({
  status: entityStatus.optional(),
});

export const poStatus = z.enum([
  'draft',
  'submitted',
  'confirmed',
  'partial',
  'received',
  'closed',
  'cancelled',
]);

export const purchaseOrderLineSchema = z.object({
  id: uuid,
  variant_id: uuid,
  product_name: z.string(),
  variant_name: z.string().nullable(),
  sku: z.string(),
  vendor_sku: z.string().nullable(),
  quantity_ordered: quantity,
  quantity_received: quantity,
  unit_cost: costDecimal,
  line_total_minor: z.string(),
});

export const purchaseOrderSchema = z.object({
  id: uuid,
  store_id: uuid,
  vendor_id: uuid,
  vendor_name: z.string(),
  reference: z.string(),
  status: poStatus,
  expected_at: z.string().nullable(),
  subtotal_minor: z.string(),
  shipping_minor: z.string(),
  tax_minor: z.string(),
  total_minor: z.string(),
  note: z.string().nullable(),
  created_at: timestamp,
  lines: z.array(purchaseOrderLineSchema).optional(),
});

export const createPurchaseOrderLineSchema = z.object({
  variant_id: uuid,
  vendor_sku: z.string().max(64).optional(),
  quantity_ordered: quantity,
  unit_cost: costDecimal,
});

export const createPurchaseOrderSchema = z.object({
  store_id: uuid,
  vendor_id: uuid,
  reference: z.string().min(1).max(64),
  expected_at: z.string().optional(),
  note: z.string().max(1000).optional(),
  lines: z.array(createPurchaseOrderLineSchema).min(1).max(200),
});

export const receivePurchaseOrderLineSchema = z.object({
  po_line_id: uuid,
  quantity_received: quantity,
  /** Only when the vendor invoice disagrees with the PO -- otherwise the line's own ordered cost applies. */
  unit_cost: costDecimal.optional(),
});

export const receivePurchaseOrderSchema = z.object({
  vendor_invoice_no: z.string().max(64).optional(),
  note: z.string().max(1000).optional(),
  lines: z.array(receivePurchaseOrderLineSchema).min(1).max(200),
});

export type Vendor = z.infer<typeof vendorSchema>;
export type VendorListRow = z.infer<typeof vendorListRowSchema>;
export type VendorItem = z.infer<typeof vendorItemSchema>;
export type VendorInvoice = z.infer<typeof vendorInvoiceSchema>;
export type VendorDetail = z.infer<typeof vendorDetailSchema>;
export type CreateVendor = z.infer<typeof createVendorSchema>;
export type UpdateVendor = z.infer<typeof updateVendorSchema>;
export type PoStatus = z.infer<typeof poStatus>;
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;
export type CreatePurchaseOrder = z.infer<typeof createPurchaseOrderSchema>;
export type ReceivePurchaseOrder = z.infer<typeof receivePurchaseOrderSchema>;
