/**
 * Invoice ingestion: a place for an uploaded vendor invoice to sit for human
 * review before anything it says becomes a real purchase order, a real
 * receipt, or real stock.
 *
 * The one rule every AI-facing field on a line exists to protect: AI only
 * ever writes `ai_suggested_*`/`ai_confidence`. Nothing here lets an
 * extraction step create a product, change a price, or move stock by
 * itself -- a human does that, through the real endpoints that already do
 * it, with these values as a starting point.
 */

import { z } from 'zod';
import { uuid, timestamp, quantity, costDecimal } from './primitives.js';

export const invoiceImportStatus = z.enum(['uploaded', 'parsed', 'reviewed', 'committed', 'failed']);
export const invoiceImportLineStatus = z.enum(['pending', 'matched', 'split', 'new_product', 'ignored']);
export const invoiceSourceFormat = z.enum(['pdf', 'png', 'jpg', 'csv', 'edi']);

export const invoiceImportLineSchema = z.object({
  id: uuid,
  invoice_import_id: uuid,
  line_no: z.number().int(),
  split_from_line_id: uuid.nullable(),
  raw_text: z.string(),
  parsed_quantity: quantity.nullable(),
  parsed_unit_cost: costDecimal.nullable(),
  parsed_description: z.string().nullable(),
  parsed_vendor_sku: z.string().nullable(),
  ai_suggested_variant_id: uuid.nullable(),
  /** Denormalized for display only -- set whenever `ai_suggested_variant_id` is, never sent by a client. */
  ai_suggested_product_name: z.string().nullable(),
  ai_suggested_variant_name: z.string().nullable(),
  ai_confidence: z.number().nullable(),
  ai_suggested_brand: z.string().nullable(),
  ai_suggested_category: z.string().nullable(),
  ai_suggested_product_description: z.string().nullable(),
  is_ambiguous_multi_item: z.boolean(),
  status: invoiceImportLineStatus,
  resolved_variant_id: uuid.nullable(),
  created_at: timestamp,
});

export const invoiceImportSchema = z.object({
  id: uuid,
  store_id: uuid,
  vendor_id: uuid.nullable(),
  vendor_name: z.string().nullable(),
  purchase_order_id: uuid.nullable(),
  source_filename: z.string(),
  source_content_type: z.string(),
  source_format: invoiceSourceFormat,
  invoice_total_minor: z.string().nullable(),
  vendor_invoice_no: z.string().nullable(),
  status: invoiceImportStatus,
  parse_error: z.string().nullable(),
  created_at: timestamp,
  committed_at: timestamp.nullable(),
  lines: z.array(invoiceImportLineSchema).optional(),
});

/**
 * The non-file fields that ride alongside the upload in the same multipart
 * request -- the file itself is handled by `@fastify/multipart`, not by this
 * schema, since a Zod object can't validate a stream.
 */
export const createInvoiceImportSchema = z.object({
  store_id: uuid,
  vendor_id: uuid.optional(),
});

export type InvoiceImportStatus = z.infer<typeof invoiceImportStatus>;
export type InvoiceImportLineStatus = z.infer<typeof invoiceImportLineStatus>;
export type InvoiceSourceFormat = z.infer<typeof invoiceSourceFormat>;
export type InvoiceImport = z.infer<typeof invoiceImportSchema>;
export type InvoiceImportLine = z.infer<typeof invoiceImportLineSchema>;
export type CreateInvoiceImport = z.infer<typeof createInvoiceImportSchema>;
