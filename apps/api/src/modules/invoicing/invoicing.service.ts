import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { CreateInvoiceImport, InvoiceSourceFormat } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const IMPORT_COLUMNS = `ii.id, ii.store_id, ii.vendor_id, v.name AS vendor_name, ii.purchase_order_id,
       ii.source_filename, ii.source_content_type, ii.source_format,
       ii.invoice_total_minor::text, ii.vendor_invoice_no, ii.status, ii.parse_error,
       ii.created_at, ii.committed_at`;

const LINE_COLUMNS = `l.id, l.invoice_import_id, l.line_no, l.split_from_line_id, l.raw_text,
       l.parsed_quantity::text, l.parsed_unit_cost::text, l.parsed_description, l.parsed_vendor_sku,
       l.ai_suggested_variant_id, sp.name AS ai_suggested_product_name, sv.variant_name AS ai_suggested_variant_name,
       l.ai_confidence::float8 AS ai_confidence, l.ai_suggested_brand,
       l.ai_suggested_category, l.ai_suggested_product_description, l.is_ambiguous_multi_item,
       l.status, l.resolved_variant_id, l.created_at`;

const LINE_FROM = `invoice_import_lines l
       LEFT JOIN product_variants sv ON sv.id = l.ai_suggested_variant_id
       LEFT JOIN products sp ON sp.id = sv.product_id`;

interface ParsedCsvLine {
  rawText: string;
  quantity: string | null;
  unitCost: string | null;
  description: string | null;
  vendorSku: string | null;
}

const HEADER_ALIASES = {
  quantity: ['qty', 'quantity'],
  unit_cost: ['cost', 'unit_cost', 'price', 'unit_price'],
  description: ['description', 'item', 'name', 'product'],
  vendor_sku: ['sku', 'vendor_sku', 'item_code', 'code'],
} as const;

/** `"Unit Cost"`, `"unit-cost"` and `"unit_cost"` are the same header to a human; collapsing everything but letters and digits before comparing is what makes them the same header here too. */
function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findColumnKey(row: Record<string, string>, aliases: readonly string[]): string | null {
  const normalizedAliases = aliases.map(normalizeHeader);
  const key = Object.keys(row).find((k) => normalizedAliases.includes(normalizeHeader(k)));
  return key ?? null;
}

function toNumericStringOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  if (!cleaned || Number.isNaN(Number(cleaned))) return null;
  return cleaned;
}

/**
 * A CSV's own header row does all the work of separating quantity/cost/
 * description/SKU -- recognized by a short list of common header spellings,
 * no AI needed for a file that already arrives structured. A header this
 * doesn't recognize just means that field stays null for review; `rawText`
 * always keeps the whole row regardless, so nothing is silently dropped.
 */
function parseCsvLines(buffer: Buffer): ParsedCsvLine[] {
  const rows = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return rows.map((row) => {
    const quantityKey = findColumnKey(row, HEADER_ALIASES.quantity);
    const costKey = findColumnKey(row, HEADER_ALIASES.unit_cost);
    const descriptionKey = findColumnKey(row, HEADER_ALIASES.description);
    const skuKey = findColumnKey(row, HEADER_ALIASES.vendor_sku);

    return {
      rawText: Object.entries(row)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', '),
      quantity: quantityKey ? toNumericStringOrNull(row[quantityKey]) : null,
      unitCost: costKey ? toNumericStringOrNull(row[costKey]) : null,
      description: descriptionKey ? (row[descriptionKey] || null) : null,
      vendorSku: skuKey ? (row[skuKey] || null) : null,
    };
  });
}

function sourceFormatFor(contentType: string, filename: string): InvoiceSourceFormat {
  const lower = filename.toLowerCase();
  if (contentType === 'text/csv' || contentType === 'application/vnd.ms-excel' || lower.endsWith('.csv')) {
    return 'csv';
  }
  if (contentType === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (contentType === 'image/png' || lower.endsWith('.png')) return 'png';
  if (contentType === 'image/jpeg' || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpg';
  // A plain text file with no more specific type is, in this system, an
  // attempted EDI document -- the rare vendor who actually sends one.
  return 'edi';
}

@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: ObjectStorageService,
  ) {}

  async list(orgId: string, storeId?: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${IMPORT_COLUMNS}
         FROM invoice_imports ii
         LEFT JOIN vendors v ON v.id = ii.vendor_id
         WHERE ($1::uuid IS NULL OR ii.store_id = $1)
         ORDER BY ii.created_at DESC`,
        [storeId ?? null],
      );
      return rows;
    });
  }

  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, (tx) => this.loadImport(tx, id));
  }

  /** Stores the uploaded file and records it. Nothing is parsed yet -- see `parse`. */
  async create(
    orgId: string,
    actorUserId: string,
    input: CreateInvoiceImport,
    file: { buffer: Buffer; filename: string; contentType: string },
  ) {
    const sourceFormat = sourceFormatFor(file.contentType, file.filename);
    const objectKey = `${orgId}/${randomUUID()}-${file.filename}`;

    await this.storage.put(objectKey, file.buffer, file.contentType);

    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO invoice_imports
           (org_id, store_id, vendor_id, source_object_key, source_content_type, source_filename,
            source_format, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.store_id,
          input.vendor_id ?? null,
          objectKey,
          file.contentType,
          file.filename,
          sourceFormat,
          actorUserId,
        ],
      );
      return this.loadImport(tx, rows[0]!.id);
    });
  }

  /**
   * CSV only, for now. PDF/image extraction and AI-assisted matching are
   * later slices of this same system -- this proves upload, storage, and the
   * staging table round-trip correctly before any of that exists. A parse
   * failure lands the import on `status='failed'` with `parse_error` set,
   * not a 500 -- a malformed file is an expected outcome to show a reviewer,
   * not a server error.
   */
  async parse(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: importRows } = await tx.query<{
        id: string;
        source_object_key: string;
        source_format: string;
      }>(`SELECT id, source_object_key, source_format FROM invoice_imports WHERE id = $1 FOR UPDATE`, [id]);
      const invoiceImport = importRows[0];
      if (!invoiceImport) throw ApiException.notFound('invoice import');

      if (invoiceImport.source_format !== 'csv') {
        throw new ApiException(
          'validation_failed',
          `parsing a "${invoiceImport.source_format}" invoice isn't built yet -- only csv is, for now`,
          { retryable: false },
        );
      }

      try {
        const buffer = await this.storage.get(invoiceImport.source_object_key);
        const lines = parseCsvLines(buffer);

        for (const [index, line] of lines.entries()) {
          await tx.query(
            `INSERT INTO invoice_import_lines
               (org_id, invoice_import_id, line_no, raw_text, parsed_quantity, parsed_unit_cost,
                parsed_description, parsed_vendor_sku)
             VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
            [id, index + 1, line.rawText, line.quantity, line.unitCost, line.description, line.vendorSku],
          );
        }

        await tx.query(`UPDATE invoice_imports SET status = 'parsed' WHERE id = $1`, [id]);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'unknown parse error';
        this.logger.warn({ id, err: message }, 'invoice parse failed');
        await tx.query(`UPDATE invoice_imports SET status = 'failed', parse_error = $2 WHERE id = $1`, [
          id,
          message,
        ]);
      }

      return this.loadImport(tx, id);
    });
  }

  /**
   * The matching cascade -- deterministic, free, no AI. Every `pending` line
   * with nothing suggested yet is tried, in order, against: an exact barcode
   * (in case the invoice's own "code" column is actually a UPC), then this
   * vendor's own SKU mapping (`vendor_variants`, populated by an earlier
   * receipt against this same vendor -- unused until now), then a fuzzy
   * trigram match on the description against the catalog's own product/
   * variant names. Only when none of those find anything does a line stay
   * fully unmatched, for AI (not built yet) or a human to resolve by hand.
   *
   * This only ever writes `ai_suggested_variant_id`/`ai_confidence` -- never
   * `resolved_variant_id` or a status change. A suggestion, however certain,
   * is not the same thing as a human confirming it.
   */
  async match(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: importRows } = await tx.query<{ id: string; vendor_id: string | null }>(
        `SELECT id, vendor_id FROM invoice_imports WHERE id = $1`,
        [id],
      );
      if (!importRows[0]) throw ApiException.notFound('invoice import');
      const vendorId = importRows[0].vendor_id;

      const { rows: lines } = await tx.query<{
        id: string;
        parsed_vendor_sku: string | null;
        parsed_description: string | null;
      }>(
        `SELECT id, parsed_vendor_sku, parsed_description FROM invoice_import_lines
         WHERE invoice_import_id = $1 AND status = 'pending' AND ai_suggested_variant_id IS NULL`,
        [id],
      );

      let matched = 0;
      for (const line of lines) {
        const found = await this.findMatch(tx, vendorId, line.parsed_vendor_sku, line.parsed_description);
        if (found) {
          await tx.query(
            `UPDATE invoice_import_lines SET ai_suggested_variant_id = $2, ai_confidence = $3 WHERE id = $1`,
            [line.id, found.variantId, found.confidence],
          );
          matched++;
        }
      }

      return { ...(await this.loadImport(tx, id)), matched_count: matched, candidate_count: lines.length };
    });
  }

  private async findMatch(
    tx: PoolClient,
    vendorId: string | null,
    vendorSku: string | null,
    description: string | null,
  ): Promise<{ variantId: string; confidence: number } | null> {
    if (vendorSku) {
      const { rows: barcodeRows } = await tx.query<{ id: string }>(
        `SELECT v.id FROM variant_barcodes b
         JOIN product_variants v ON v.id = b.variant_id
         WHERE b.barcode = $1 AND v.status = 'active'
         LIMIT 1`,
        [vendorSku],
      );
      if (barcodeRows[0]) return { variantId: barcodeRows[0].id, confidence: 1 };

      if (vendorId) {
        const { rows: vendorSkuRows } = await tx.query<{ variant_id: string }>(
          `SELECT vv.variant_id FROM vendor_variants vv
           JOIN product_variants v ON v.id = vv.variant_id
           WHERE vv.vendor_id = $1 AND vv.vendor_sku = $2 AND v.status = 'active'
           LIMIT 1`,
          [vendorId, vendorSku],
        );
        if (vendorSkuRows[0]) return { variantId: vendorSkuRows[0].variant_id, confidence: 1 };
      }
    }

    if (description) {
      const { rows: fuzzyRows } = await tx.query<{ id: string; score: number }>(
        `SELECT v.id,
                similarity(p.name || ' ' || COALESCE(v.variant_name, ''), $1) AS score
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.status = 'active' AND p.status = 'active'
         ORDER BY score DESC
         LIMIT 1`,
        [description],
      );
      const best = fuzzyRows[0];
      // pg_trgm's own default similarity_threshold GUC is 0.3 -- below that,
      // a "best available" match is noise, not a suggestion worth showing.
      if (best && best.score > 0.3) return { variantId: best.id, confidence: best.score };
    }

    return null;
  }

  private async loadImport(tx: PoolClient, id: string) {
    const { rows } = await tx.query(
      `SELECT ${IMPORT_COLUMNS} FROM invoice_imports ii LEFT JOIN vendors v ON v.id = ii.vendor_id WHERE ii.id = $1`,
      [id],
    );
    const invoiceImport = rows[0];
    if (!invoiceImport) throw ApiException.notFound('invoice import');

    const { rows: lines } = await tx.query(
      `SELECT ${LINE_COLUMNS} FROM ${LINE_FROM} WHERE l.invoice_import_id = $1 ORDER BY l.line_no`,
      [id],
    );

    return { ...invoiceImport, lines };
  }
}
