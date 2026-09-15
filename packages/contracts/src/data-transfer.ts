/**
 * Importing a spreadsheet, and exporting one.
 *
 * The rule this file exists to hold: **nothing is written until a dry run has
 * been reviewed.** An import moves in three separate calls -- upload (which
 * proposes a mapping), dry run (which validates every row and reports what
 * would happen), and commit (which is refused unless a dry run for the
 * current mapping exists). A single "import this file" call would be shorter
 * and is precisely the shape that lets a wrong column mapping corrupt a whole
 * catalog before anyone can see it.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';

export const importEntity = z.enum(['item', 'customer']);
export const importJobStatus = z.enum(['uploaded', 'mapped', 'validated', 'committed', 'failed']);

/** One field an import can fill, as the review screen needs to render it. */
export const importFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  required: z.boolean(),
});

/**
 * What a dry run found for one row it will not import. `row_number` counts
 * data rows from 1 (the header is not row 1), which is what a person reading
 * their own spreadsheet will be looking for.
 */
export const importRowIssueSchema = z.object({
  row_number: z.number().int(),
  message: z.string(),
  /** The row's identifying value (SKU, phone, email) when there is one, to find it in the file. */
  identifier: z.string().nullable(),
});

/**
 * The counts a person decides on. `create` plus `update` is what will be
 * written; `skip` is what will not, and every skip has a reason in `issues`.
 */
export const importDryRunSchema = z.object({
  total_rows: z.number().int(),
  create_count: z.number().int(),
  update_count: z.number().int(),
  skip_count: z.number().int(),
  /** Capped -- a file with 4,000 bad rows does not need 4,000 messages to make the point. */
  issues: z.array(importRowIssueSchema),
  /** Columns in the file that no field is mapped to. Not an error; worth seeing before committing. */
  ignored_columns: z.array(z.string()),
  /**
   * Things that will happen and are probably not what was intended, but
   * don't stop a row importing -- a category named in the file that doesn't
   * exist, say. Distinct from `issues`, which are rows that will be skipped:
   * a warning still imports, it just imports with something missing.
   */
  warnings: z.array(z.string()),
  /** A preview of what the first few rows will actually become, field by field. */
  sample: z.array(z.record(z.string(), z.string())),
});

export const importJobSchema = z.object({
  id: uuid,
  entity: importEntity,
  store_id: uuid.nullable(),
  source_filename: z.string(),
  source_format: z.string(),
  headers: z.array(z.string()),
  mapping: z.record(z.string(), z.string()),
  /** Which fields the AI tier supplied rather than the deterministic pass. A hint for review, never a gate. */
  ai_mapped_fields: z.array(z.string()),
  /** True when this mapping came from a layout someone already confirmed. */
  reused_saved_mapping: z.boolean().optional(),
  row_count: z.number().int(),
  status: importJobStatus,
  dry_run: importDryRunSchema.nullable(),
  error: z.string().nullable(),
  created_at: timestamp,
  committed_at: timestamp.nullable(),
  /** The fields this entity supports, sent with the job so the review screen needs no second call. */
  fields: z.array(importFieldSchema).optional(),
});

/** The mapping a human confirmed. Replaces whatever was proposed, wholesale. */
export const setImportMappingSchema = z.object({
  mapping: z.record(z.string(), z.string()),
  /** Remember this layout, so the next file with the same headers maps itself. */
  remember: z.boolean().optional(),
});

/**
 * Commit carries the job's own id rather than a mapping: the mapping that
 * runs is the one the dry run validated, never one supplied alongside the
 * commit, which would make the review meaningless.
 */
export const importCommitResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  issues: z.array(importRowIssueSchema),
});

export const exportFormat = z.enum(['csv', 'xlsx']);

export type ImportEntity = z.infer<typeof importEntity>;
export type ImportJobStatus = z.infer<typeof importJobStatus>;
export type ImportField = z.infer<typeof importFieldSchema>;
export type ImportRowIssue = z.infer<typeof importRowIssueSchema>;
export type ImportDryRun = z.infer<typeof importDryRunSchema>;
export type ImportJob = z.infer<typeof importJobSchema>;
export type SetImportMapping = z.infer<typeof setImportMappingSchema>;
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;
export type ExportFormat = z.infer<typeof exportFormat>;

/**
 * AI Structured Outputs. Same rules as the invoicing ones: every field
 * present, `null` rather than omitted, plain JSON types.
 *
 * The model is asked only about fields the deterministic pass could not
 * place, and may only answer with a column name it was given -- validated by
 * `sanitizeMapping` on the way back, since a model naming a column that
 * doesn't exist would otherwise read as `undefined` on every row.
 */
export const aiColumnGuessSchema = z.object({
  field: z.string(),
  column: z.string().nullable(),
  confidence: z.number(),
});

export const aiColumnMappingSchema = z.object({
  guesses: z.array(aiColumnGuessSchema),
});

export type AiColumnGuess = z.infer<typeof aiColumnGuessSchema>;
export type AiColumnMapping = z.infer<typeof aiColumnMappingSchema>;
