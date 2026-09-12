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

export type SalesSummaryQuery = z.infer<typeof salesSummaryQuerySchema>;
export type SalesSummary = z.infer<typeof salesSummarySchema>;
