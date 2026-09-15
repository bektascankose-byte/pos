/**
 * Reading and writing the two file shapes a shop actually has: a CSV, and
 * whatever Excel saved.
 *
 * Everything here works in strings. A spreadsheet cell has no types worth
 * trusting -- Excel will hand back a SKU of `8.10071E+11` for a barcode
 * somebody typed as digits, a price as a float, and a date as a serial
 * number -- so cells are rendered to text once, here, and every consumer
 * parses from text with the rules of its own field. The one place that
 * matters most: a barcode or SKU must never be parsed as a number, because
 * leading zeros are significant and 12-digit codes do not survive a float.
 */

import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

export type TabularFormat = 'csv' | 'xlsx';

export interface TabularTable {
  /** The header row, in file order, exactly as written. */
  headers: string[];
  /** Data rows keyed by header. A short row's missing columns are `''`, never undefined. */
  rows: Record<string, string>[];
}

/** How many rows a single import may carry. A migration export of a whole catalog is thousands; a million is a mistake. */
export const MAX_IMPORT_ROWS = 50_000;

export function formatFor(contentType: string, filename: string): TabularFormat | null {
  const lower = filename.toLowerCase();
  if (contentType === 'text/csv' || lower.endsWith('.csv')) return 'csv';
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    lower.endsWith('.xlsx')
  ) {
    return 'xlsx';
  }
  // Excel labels a saved CSV this way, and it is also the legacy .xls type --
  // which exceljs cannot read. Trust the extension to tell them apart.
  if (contentType === 'application/vnd.ms-excel') return lower.endsWith('.csv') ? 'csv' : null;
  return null;
}

/**
 * A spreadsheet cell to the string a person would see in it.
 *
 * `richText` and `hyperlink` cells are objects; a formula cell carries its
 * computed `result`, which is the value that matters -- a column of
 * `=B2*1.4` prices should import as the prices, not as the formula. A date
 * is rendered ISO, since a locale-formatted one cannot be parsed back
 * unambiguously.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('').trim();
    }
    if ('result' in value) return cellToString(value.result as ExcelJS.CellValue);
    if ('error' in value) return '';
  }
  return String(value).trim();
}

/**
 * Header names are made unique before anything else reads them. A sheet with
 * two columns both called "Price" would otherwise silently lose one when rows
 * are keyed by header -- and a duplicated header is common in exports that
 * concatenate sections.
 */
function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

export function readTable(buffer: Buffer, format: TabularFormat): Promise<TabularTable> {
  return format === 'csv' ? Promise.resolve(readCsv(buffer)) : readXlsx(buffer);
}

function readCsv(buffer: Buffer): TabularTable {
  // `columns: false` so the header row is read as a row like any other and
  // this file owns the de-duplication above, rather than csv-parse silently
  // resolving a repeated header its own way.
  const matrix = parse(buffer, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as string[][];

  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = uniqueHeaders(matrix[0]!.map((h) => String(h ?? '')));
  return { headers, rows: matrix.slice(1).map((cells) => toRow(headers, cells.map((c) => String(c ?? '').trim()))) };
}

async function readXlsx(buffer: Buffer): Promise<TabularTable> {
  const workbook = new ExcelJS.Workbook();
  // exceljs types this as a Node Buffer in some versions and an ArrayBuffer in
  // others; the cast keeps one call site rather than branching on the shape.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const matrix: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // `row.values` is 1-indexed with a hole at 0 -- exceljs's own convention.
    const values = (row.values as ExcelJS.CellValue[]).slice(1);
    matrix.push(values.map(cellToString));
  });

  // Blank leading rows are common in exports with a title banner above the
  // real table; the first row with more than one non-empty cell is the header.
  const headerIndex = matrix.findIndex((row) => row.filter(Boolean).length > 1);
  if (headerIndex === -1) return { headers: [], rows: [] };

  const headers = uniqueHeaders(matrix[headerIndex]!);
  const rows = matrix
    .slice(headerIndex + 1)
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map((cells) => toRow(headers, cells));
  return { headers, rows };
}

function toRow(headers: string[], cells: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  headers.forEach((header, index) => {
    row[header] = cells[index] ?? '';
  });
  return row;
}

/**
 * Identifies a layout so the mapping confirmed for it can be found again.
 *
 * Over the normalized header row in order: "Unit Cost", "unit_cost" and
 * "UNIT COST" are the same sheet to anyone reading it and should be the same
 * sheet here. Order is kept, because the same columns in a different order
 * genuinely are a different layout to a row parser.
 */
export function headerHash(headers: string[]): string {
  const normalized = headers
    .map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .join('|');
  return createHash('sha256').update(normalized).digest('hex');
}

/** RFC 4180: quote anything containing a comma, quote or newline, and double any inner quotes. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(headers: string[], rows: string[][]): Buffer {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // A BOM so Excel opens a UTF-8 export without mangling accented names --
  // without it, "Café" arrives as "CafÃ©" on a default Windows install.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf-8');
}

/**
 * Every cell is written as text on purpose. An export exists to be read back
 * in, and Excel will helpfully turn a SKU like `00123` into the number 123
 * and a 12-digit barcode into scientific notation the moment it decides a
 * column is numeric. Round-tripping matters more here than sortable columns.
 */
export async function writeXlsx(sheetName: string, headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);

  sheet.columns.forEach((column, index) => {
    column.numFmt = '@';
    const header = headers[index] ?? '';
    const widest = rows.reduce((max, row) => Math.max(max, (row[index] ?? '').length), header.length);
    column.width = Math.min(Math.max(widest + 2, 10), 50);
  });

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}
