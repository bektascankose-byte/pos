/**
 * Reporting contracts.
 *
 * Read-only aggregates over data other modules already own. This file adds
 * no new tables and no new write path -- it exists so "what did we sell
 * today" doesn't mean pulling every row over HTTP and summing them in a
 * browser tab.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';
import { paymentMethod } from './sales.js';

export const salesSummaryQuerySchema = z.object({
  store_id: uuid.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export const salesSummarySchema = z.object({
  sale_count: z.number().int().nonnegative(),
  gross_minor: z.string(),
  tax_minor: z.string(),
  average_ticket_minor: z.string(),
});

/**
 * The shared filter shape for every range-based report below. Unlike the
 * summary above (which defaults to "today" when the caller omits a range),
 * a trend or a breakdown over an unbounded range is not a useful report, so
 * `from`/`to` are required here.
 */
export const reportRangeQuerySchema = z.object({
  store_id: uuid.optional(),
  from: timestamp,
  to: timestamp,
});

export const salesTrendPointSchema = z.object({
  date: z.string(), // YYYY-MM-DD, one point per calendar day in the range
  sale_count: z.number().int().nonnegative(),
  gross_minor: z.string(),
});

export const topProductRowSchema = z.object({
  product_id: uuid,
  product_name: z.string(),
  category_name: z.string().nullable(),
  quantity: z.string(), // numeric(14,3), stays a string for the same reason costs and quantities always do
  gross_minor: z.string(),
});

export const topProductsQuerySchema = reportRangeQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const byCashierRowSchema = z.object({
  cashier_user_id: uuid,
  cashier_name: z.string(),
  sale_count: z.number().int().nonnegative(),
  gross_minor: z.string(),
});

export const byPaymentMethodRowSchema = z.object({
  method: paymentMethod,
  payment_count: z.number().int().nonnegative(),
  amount_minor: z.string(),
});

export type SalesSummaryQuery = z.infer<typeof salesSummaryQuerySchema>;
export type SalesSummary = z.infer<typeof salesSummarySchema>;
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;
export type SalesTrendPoint = z.infer<typeof salesTrendPointSchema>;
export type TopProductsQuery = z.infer<typeof topProductsQuerySchema>;
export type TopProductRow = z.infer<typeof topProductRowSchema>;
export type ByCashierRow = z.infer<typeof byCashierRowSchema>;
export type ByPaymentMethodRow = z.infer<typeof byPaymentMethodRowSchema>;
