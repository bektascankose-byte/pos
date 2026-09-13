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

/**
 * AI Structured Outputs schemas -- a different shape than the rest of this
 * file on purpose. OpenAI's strict mode requires every field present (a bare
 * `.optional()` is rejected; use `.nullable()` instead) and plain JSON-native
 * types, so the model returns `null` for anything it can't find rather than
 * omitting the field. These describe a suggestion only -- the caller is what
 * decides whether and how any of it reaches a real column.
 */
export const aiExtractedLineSchema = z.object({
  raw_text: z.string(),
  vendor_sku: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  unit_cost: z.number().nullable(),
});

export const aiExtractedInvoiceSchema = z.object({
  vendor_invoice_no: z.string().nullable(),
  invoice_total: z.number().nullable(),
  lines: z.array(aiExtractedLineSchema),
});

/** One catalog row offered to the AI matching tier as a candidate for a single line -- never the whole catalog, just a bounded, already-validated shortlist. */
export const aiMatchCandidateSchema = z.object({
  index: z.number().int(),
  product_name: z.string(),
  variant_name: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
});

export const aiMatchLineInputSchema = z.object({
  line_index: z.number().int(),
  raw_text: z.string(),
  description: z.string().nullable(),
  vendor_sku: z.string().nullable(),
  candidates: z.array(aiMatchCandidateSchema),
});

/**
 * `matched_candidate_index` is an index into that same line's own
 * `candidates` array, never a bare id -- the model can only ever point back
 * at a variant this org's own catalog search already found and the caller
 * already validated, it can never conjure one.
 */
export const aiLineMatchPredictionSchema = z.object({
  line_index: z.number().int(),
  matched_candidate_index: z.number().int().nullable(),
  confidence: z.number(),
  suggested_brand: z.string().nullable(),
  suggested_category: z.string().nullable(),
  suggested_product_description: z.string().nullable(),
  is_ambiguous_multi_item: z.boolean(),
});

export const aiMatchPredictionsSchema = z.object({
  predictions: z.array(aiLineMatchPredictionSchema),
});

export type AiExtractedLine = z.infer<typeof aiExtractedLineSchema>;
export type AiExtractedInvoice = z.infer<typeof aiExtractedInvoiceSchema>;
export type AiMatchCandidate = z.infer<typeof aiMatchCandidateSchema>;
export type AiMatchLineInput = z.infer<typeof aiMatchLineInputSchema>;
export type AiLineMatchPrediction = z.infer<typeof aiLineMatchPredictionSchema>;
export type AiMatchPredictions = z.infer<typeof aiMatchPredictionsSchema>;
