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
import { uuid, timestamp, quantity, costDecimal, phone, email, entityStatus } from './primitives.js';

export const vendorSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  contact_name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  payment_terms: z.string().nullable(),
  lead_time_days: z.number().int().nonnegative(),
  status: entityStatus,
});

export const createVendorSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(256),
  contact_name: z.string().max(256).optional(),
  phone: phone.optional(),
  email: email.optional(),
  payment_terms: z.string().max(32).optional(),
  lead_time_days: z.number().int().nonnegative().optional(),
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
export type CreateVendor = z.infer<typeof createVendorSchema>;
export type PoStatus = z.infer<typeof poStatus>;
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;
export type CreatePurchaseOrder = z.infer<typeof createPurchaseOrderSchema>;
export type ReceivePurchaseOrder = z.infer<typeof receivePurchaseOrderSchema>;
