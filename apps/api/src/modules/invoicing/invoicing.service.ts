import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { PDFParse } from 'pdf-parse';
import {
  costToMinor,
  money,
  type CreateInvoiceImport,
  type InvoiceSourceFormat,
  type AiMatchLineInput,
  type ResolveInvoiceLine,
  type SplitInvoiceLine,
  type CreateProductForLine,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { AiService, MAX_DOCUMENT_CHARS } from '../../platform/ai/ai.service.js';
import { PurchasingService } from '../purchasing/purchasing.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
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
       l.status, l.resolved_variant_id, rp.name AS resolved_product_name, rv.variant_name AS resolved_variant_name,
       l.resolved_by, l.resolved_at, l.created_at`;

const LINE_FROM = `invoice_import_lines l
       LEFT JOIN product_variants sv ON sv.id = l.ai_suggested_variant_id
       LEFT JOIN products sp ON sp.id = sv.product_id
       LEFT JOIN product_variants rv ON rv.id = l.resolved_variant_id
       LEFT JOIN products rp ON rp.id = rv.product_id`;

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

/** `"Unit Cost"`, `"unit-cost"` and `"unit_cost"` are the same header to a human -- split into lowercase word tokens is what makes them comparable here too, and what lets a compound header like `"Item Description"` still recognize the word `"description"` inside it. */
function headerTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A single-word alias (`"sku"`) matches a header if any of its tokens equal
 * that word -- so `"Item SKU"` still matches even though it isn't *only*
 * "sku". A multi-word alias (`"unit_cost"` -> `["unit","cost"]`) requires
 * those words adjacent and in order, so it doesn't fire on an unrelated
 * header that merely contains both words separately.
 *
 * `claimed` prevents one column from being recognized for two different
 * fields at once -- e.g. "Item Code" legitimately matches the generic
 * `description` alias "item" AND the `vendor_sku` alias "code". Callers
 * resolve the more specific fields (sku, cost, quantity) before the generic
 * `description` one, so a header already claimed by a specific field is
 * skipped rather than also being read as the description.
 */
function findColumnKey(row: Record<string, string>, aliases: readonly string[], claimed: Set<string>): string | null {
  const key = Object.keys(row).find((k) => {
    if (claimed.has(k)) return false;
    const tokens = headerTokens(k);
    return aliases.some((alias) => {
      const aliasTokens = headerTokens(alias);
      return aliasTokens.length === 1
        ? tokens.includes(aliasTokens[0]!)
        : tokens.join(' ').includes(aliasTokens.join(' '));
    });
  });
  if (key) claimed.add(key);
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
    const claimed = new Set<string>();
    // Specific fields claim their column first; `description`'s generic
    // aliases ("item", "name", "product") run last so they never steal a
    // column a more specific field already recognized (see findColumnKey).
    const quantityKey = findColumnKey(row, HEADER_ALIASES.quantity, claimed);
    const costKey = findColumnKey(row, HEADER_ALIASES.unit_cost, claimed);
    const skuKey = findColumnKey(row, HEADER_ALIASES.vendor_sku, claimed);
    const descriptionKey = findColumnKey(row, HEADER_ALIASES.description, claimed);

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

/** Whole-document text for the AI extraction path. `pdf-parse` v2's own destroy() releases the worker it spins up per parse. */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
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
    private readonly ai: AiService,
    private readonly purchasing: PurchasingService,
    private readonly catalog: CatalogService,
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
   * CSV is parsed deterministically from its own header row. PDF and EDI
   * have no such structure, so their text goes through `AiService` instead
   * -- same output shape, different source. Image extraction (PNG/JPG, or a
   * scanned PDF) isn't built yet; that's vision, and vision ships after text
   * extraction is proven. A parse failure lands the import on
   * `status='failed'` with `parse_error` set, not a 500 -- a malformed file
   * or a flaky model call is an expected outcome to show a reviewer, not a
   * server error. A *missing* AI configuration is different: that's not
   * this particular file's problem, so it throws `provider_unavailable`
   * before anything is attempted, rather than being recorded as a failed
   * parse of an otherwise-fine invoice.
   */
  async parse(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: importRows } = await tx.query<{
        id: string;
        source_object_key: string;
        source_format: InvoiceSourceFormat;
      }>(`SELECT id, source_object_key, source_format FROM invoice_imports WHERE id = $1 FOR UPDATE`, [id]);
      const invoiceImport = importRows[0];
      if (!invoiceImport) throw ApiException.notFound('invoice import');
      const format = invoiceImport.source_format;

      if (format === 'png' || format === 'jpg') {
        throw new ApiException(
          'validation_failed',
          `parsing a "${format}" invoice isn't built yet -- image extraction is a later slice; csv, pdf, and edi work today`,
          { retryable: false },
        );
      }
      if (format !== 'csv' && !this.ai.isConfigured()) {
        throw new ApiException(
          'provider_unavailable',
          'AI extraction is not configured on this server -- ask an admin to set OPENAI_API_KEY and OPENAI_MODEL, or upload this invoice as a csv instead',
          { retryable: false },
        );
      }

      try {
        const buffer = await this.storage.get(invoiceImport.source_object_key);
        const parsed =
          format === 'csv'
            ? { lines: parseCsvLines(buffer), vendorInvoiceNo: null, invoiceTotalMinor: null, truncated: false }
            : await this.parseWithAi(buffer, format);

        for (const [index, line] of parsed.lines.entries()) {
          await tx.query(
            `INSERT INTO invoice_import_lines
               (org_id, invoice_import_id, line_no, raw_text, parsed_quantity, parsed_unit_cost,
                parsed_description, parsed_vendor_sku)
             VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
            [id, index + 1, line.rawText, line.quantity, line.unitCost, line.description, line.vendorSku],
          );
        }

        // `parse_error` doubles as a non-fatal note here -- status is still
        // 'parsed', not 'failed'; a reviewer just needs to know the document
        // was cut off so a missing tail of line items isn't mistaken for the
        // model having missed them.
        const warning = parsed.truncated
          ? `this document is long enough that only its first ${MAX_DOCUMENT_CHARS.toLocaleString()} characters were read -- line items past that point were not extracted`
          : null;

        await tx.query(
          `UPDATE invoice_imports
             SET status = 'parsed',
                 vendor_invoice_no = COALESCE($2, vendor_invoice_no),
                 invoice_total_minor = COALESCE($3, invoice_total_minor),
                 parse_error = $4
           WHERE id = $1`,
          [id, parsed.vendorInvoiceNo, parsed.invoiceTotalMinor, warning],
        );
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

  /** Text-based PDF and EDI both reduce to "extract text, hand it to the model" -- not parallel pipelines. */
  private async parseWithAi(
    buffer: Buffer,
    format: 'pdf' | 'edi',
  ): Promise<{
    lines: ParsedCsvLine[];
    vendorInvoiceNo: string | null;
    invoiceTotalMinor: string | null;
    truncated: boolean;
  }> {
    const text = format === 'pdf' ? await extractPdfText(buffer) : buffer.toString('utf-8');
    if (text.trim().length < 20) {
      throw new Error(
        'could not find any readable text in this file -- if this is a scanned/image pdf, that is not supported yet; only text-based pdfs are',
      );
    }

    const extracted = await this.ai.extractInvoiceLines(text);
    return {
      lines: extracted.lines.map((line) => ({
        rawText: line.raw_text,
        quantity: line.quantity !== null ? String(line.quantity) : null,
        unitCost: line.unit_cost !== null ? String(line.unit_cost) : null,
        description: line.description,
        vendorSku: line.vendor_sku,
      })),
      vendorInvoiceNo: extracted.vendor_invoice_no,
      invoiceTotalMinor: extracted.invoice_total !== null ? costToMinor(extracted.invoice_total.toFixed(2)).toString() : null,
      truncated: text.length > MAX_DOCUMENT_CHARS,
    };
  }

  /**
   * The matching cascade. Every `pending` line with nothing suggested yet is
   * tried, in order, against: an exact barcode (in case the invoice's own
   * "code" column is actually a UPC), then this vendor's own SKU mapping
   * (`vendor_variants`, populated by an earlier receipt against this same
   * vendor), then a fuzzy trigram match on the description against the
   * catalog's own product/variant names -- all three free and deterministic.
   * Only lines still unmatched after that go to AI (tier 4, skipped
   * entirely when no key is configured -- the first three tiers must keep
   * working with zero OpenAI dependency), which also predicts brand/
   * category/description and flags a line whose own text bundles more than
   * one distinct variant (the "50 boxes assorted flavor" case), for a human
   * to resolve with "Add Variants".
   *
   * This only ever writes `ai_suggested_*`/`ai_confidence` -- never
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
        raw_text: string;
        parsed_vendor_sku: string | null;
        parsed_description: string | null;
        parsed_quantity: string | null;
        parsed_unit_cost: string | null;
      }>(
        `SELECT id, raw_text, parsed_vendor_sku, parsed_description,
                parsed_quantity::text, parsed_unit_cost::text
         FROM invoice_import_lines
         WHERE invoice_import_id = $1 AND status = 'pending' AND ai_suggested_variant_id IS NULL`,
        [id],
      );

      let matched = 0;
      const stillUnmatched: typeof lines = [];
      for (const line of lines) {
        const found = await this.findMatch(tx, vendorId, line.parsed_vendor_sku, line.parsed_description);
        if (found) {
          await tx.query(
            `UPDATE invoice_import_lines SET ai_suggested_variant_id = $2, ai_confidence = $3 WHERE id = $1`,
            [line.id, found.variantId, found.confidence],
          );
          matched++;
        } else {
          stillUnmatched.push(line);
        }
      }

      let aiSuggested = 0;
      if (stillUnmatched.length > 0 && this.ai.isConfigured()) {
        try {
          aiSuggested = await this.runAiMatchTier(tx, stillUnmatched);
        } catch (e) {
          this.logger.warn(
            { id, err: e instanceof Error ? e.message : e },
            'AI matching tier failed; this run keeps whatever the deterministic tiers already found',
          );
        }
      }

      return {
        ...(await this.loadImport(tx, id)),
        matched_count: matched,
        ai_suggested_count: aiSuggested,
        candidate_count: lines.length,
      };
    });
  }

  private async runAiMatchTier(
    tx: PoolClient,
    lines: {
      id: string;
      raw_text: string;
      parsed_vendor_sku: string | null;
      parsed_description: string | null;
      parsed_quantity: string | null;
      parsed_unit_cost: string | null;
    }[],
  ): Promise<number> {
    const [{ rows: brandRows }, { rows: categoryRows }] = await Promise.all([
      tx.query<{ name: string }>(`SELECT name FROM brands WHERE status = 'active' ORDER BY name`),
      tx.query<{ name: string }>(`SELECT name FROM categories WHERE status = 'active' ORDER BY path`),
    ]);

    const candidateIdsByLine: string[][] = [];
    const lineInputs: AiMatchLineInput[] = [];

    for (const [lineIndex, line] of lines.entries()) {
      const searchText = line.parsed_description ?? line.raw_text;
      const { rows: candidateRows } = await tx.query<{
        id: string;
        product_name: string;
        variant_name: string | null;
        brand: string | null;
        category: string | null;
        cost: string;
        case_quantity: number;
        pack_quantity: number;
        score: number;
      }>(
        // Brand and category join the scored text itself, not just the
        // display fields, so a wrong-brand item with an otherwise identical
        // name scores lower and doesn't crowd the right one out of LIMIT 5.
        `SELECT v.id, p.name AS product_name, v.variant_name, b.name AS brand, c.name AS category,
                v.cost::text, v.case_quantity, v.pack_quantity,
                similarity(
                  p.name || ' ' || COALESCE(v.variant_name, '') || ' ' ||
                  COALESCE(b.name, '') || ' ' || COALESCE(c.name, ''),
                  $1
                ) AS score
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE v.status = 'active' AND p.status = 'active'
         ORDER BY score DESC
         LIMIT 5`,
        [searchText],
      );
      // Tier 3 already tried this same query at a 0.3 floor and failed; a
      // much lower floor here just keeps pure noise out of what the model
      // sees on a large catalog, not a re-run of the same cutoff.
      const candidates = candidateRows.filter((r) => r.score > 0.05);

      candidateIdsByLine.push(candidates.map((r) => r.id));
      lineInputs.push({
        line_index: lineIndex,
        raw_text: line.raw_text,
        description: line.parsed_description,
        vendor_sku: line.parsed_vendor_sku,
        quantity: line.parsed_quantity !== null ? Number(line.parsed_quantity) : null,
        unit_cost: line.parsed_unit_cost !== null ? Number(line.parsed_unit_cost) : null,
        candidates: candidates.map((r, i) => ({
          index: i,
          product_name: r.product_name,
          variant_name: r.variant_name,
          brand: r.brand,
          category: r.category,
          unit_cost: Number(r.cost),
          case_quantity: r.case_quantity,
          pack_quantity: r.pack_quantity,
        })),
      });
    }

    const predictions = await this.ai.predictMatches({
      lines: lineInputs,
      brands: brandRows.map((r) => r.name),
      categories: categoryRows.map((r) => r.name),
    });

    let suggested = 0;
    for (const prediction of predictions) {
      const line = lines[prediction.line_index];
      const candidateIds = candidateIdsByLine[prediction.line_index];
      if (!line || !candidateIds) continue;

      const matchedVariantId =
        prediction.matched_candidate_index !== null
          ? (candidateIds[prediction.matched_candidate_index] ?? null)
          : null;

      await tx.query(
        `UPDATE invoice_import_lines
           SET ai_suggested_variant_id = $2, ai_confidence = $3, ai_suggested_brand = $4,
               ai_suggested_category = $5, ai_suggested_product_description = $6, is_ambiguous_multi_item = $7
         WHERE id = $1`,
        [
          line.id,
          matchedVariantId,
          matchedVariantId ? prediction.confidence : null,
          prediction.suggested_brand,
          prediction.suggested_category,
          prediction.suggested_product_description,
          prediction.is_ambiguous_multi_item,
        ],
      );
      if (matchedVariantId) suggested++;
    }

    return suggested;
  }

  private async findMatch(
    tx: PoolClient,
    vendorId: string | null,
    vendorSku: string | null,
    description: string | null,
  ): Promise<{ variantId: string; confidence: number } | null> {
    if (vendorSku) {
      // upper(trim(...)) on both sides -- a vendor resending the same SKU
      // with different case or a trailing space would otherwise silently
      // miss an exact-match tier, the same normalization the catalog's own
      // SKU uniqueness index already applies.
      const { rows: barcodeRows } = await tx.query<{ id: string }>(
        `SELECT v.id FROM variant_barcodes b
         JOIN product_variants v ON v.id = b.variant_id
         WHERE upper(trim(b.barcode)) = upper(trim($1)) AND v.status = 'active'
         LIMIT 1`,
        [vendorSku],
      );
      if (barcodeRows[0]) return { variantId: barcodeRows[0].id, confidence: 1 };

      if (vendorId) {
        const { rows: vendorSkuRows } = await tx.query<{ variant_id: string }>(
          `SELECT vv.variant_id FROM vendor_variants vv
           JOIN product_variants v ON v.id = vv.variant_id
           WHERE vv.vendor_id = $1 AND upper(trim(vv.vendor_sku)) = upper(trim($2)) AND v.status = 'active'
           LIMIT 1`,
          [vendorId, vendorSku],
        );
        if (vendorSkuRows[0]) return { variantId: vendorSkuRows[0].variant_id, confidence: 1 };
      }
    }

    if (description) {
      // Brand and category join the scored text so a wrong-brand item with
      // an otherwise identical name doesn't outscore the right one -- the
      // same widening applied to the AI tier's own candidate search below.
      const { rows: fuzzyRows } = await tx.query<{ id: string; score: number }>(
        `SELECT v.id,
                similarity(
                  p.name || ' ' || COALESCE(v.variant_name, '') || ' ' ||
                  COALESCE(b.name, '') || ' ' || COALESCE(c.name, ''),
                  $1
                ) AS score
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
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

  /**
   * Accept the AI's own suggestion, or point a line at a different variant
   * entirely -- the same endpoint either way, since both are just "a human
   * chose this variant," only with a different starting point.
   */
  async resolveLine(
    orgId: string,
    actorUserId: string,
    importId: string,
    lineId: string,
    input: ResolveInvoiceLine,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertImportEditable(tx, importId);
      const line = await this.loadLineForUpdate(tx, importId, lineId);
      if (line.status === 'split') {
        throw new ApiException(
          'validation_failed',
          'this line was already split into variants -- resolve or ignore the split lines instead',
          { retryable: false },
        );
      }

      const { rows: variantRows } = await tx.query(
        `SELECT id FROM product_variants WHERE id = $1 AND status = 'active'`,
        [input.variant_id],
      );
      if (!variantRows[0]) throw ApiException.notFound('variant');

      await tx.query(
        `UPDATE invoice_import_lines
           SET resolved_variant_id = $2, status = $3, resolved_by = $4, resolved_at = now()
         WHERE id = $1`,
        [lineId, input.variant_id, input.is_new_product ? 'new_product' : 'matched', actorUserId],
      );

      await this.markReviewedIfDone(tx, importId);
      return this.loadImport(tx, importId);
    });
  }

  async ignoreLine(orgId: string, actorUserId: string, importId: string, lineId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertImportEditable(tx, importId);
      const line = await this.loadLineForUpdate(tx, importId, lineId);
      if (line.status === 'split') {
        throw new ApiException(
          'validation_failed',
          'this line was already split into variants -- ignore the split lines instead',
          { retryable: false },
        );
      }

      await tx.query(
        `UPDATE invoice_import_lines
           SET status = 'ignored', resolved_variant_id = NULL, resolved_by = $2, resolved_at = now()
         WHERE id = $1`,
        [lineId, actorUserId],
      );

      await this.markReviewedIfDone(tx, importId);
      return this.loadImport(tx, importId);
    });
  }

  /**
   * "Add Variants": one ambiguous line's quantity is allocated across
   * several already-existing variants, each becoming its own new sibling
   * line. Creating those variants happens on the product's own page
   * (`CatalogService.addVariant`, already built) -- this only splits an
   * already-parsed line's quantity once each variant it actually covers
   * exists to receive a share of it.
   */
  async splitLine(
    orgId: string,
    actorUserId: string,
    importId: string,
    lineId: string,
    input: SplitInvoiceLine,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertImportEditable(tx, importId);
      const line = await this.loadLineForUpdate(tx, importId, lineId);
      if (line.status === 'split') {
        throw new ApiException('validation_failed', 'this line was already split', { retryable: false });
      }

      if (line.parsed_quantity !== null) {
        const target = Number(line.parsed_quantity);
        const sum = input.items.reduce((acc, item) => acc + Number(item.quantity), 0);
        if (Math.abs(sum - target) > 0.001) {
          throw new ApiException(
            'validation_failed',
            `the split quantities add up to ${sum}, but this line was originally ${target} -- they must match exactly`,
            { retryable: false },
          );
        }
      }

      const { rows: maxRows } = await tx.query<{ next: number }>(
        `SELECT COALESCE(MAX(line_no), 0) + 1 AS next FROM invoice_import_lines WHERE invoice_import_id = $1`,
        [importId],
      );
      let nextLineNo = maxRows[0]!.next;

      for (const item of input.items) {
        const { rows: variantRows } = await tx.query(
          `SELECT id FROM product_variants WHERE id = $1 AND status = 'active'`,
          [item.variant_id],
        );
        if (!variantRows[0]) throw ApiException.notFound('variant');

        // `parsed_vendor_sku` is deliberately NOT copied from the parent: a
        // vendor's own code on an "assorted" line describes the bundle, not
        // any one resulting variant. Copying it to every child would give
        // them all the same vendor_sku, which commit's vendor_variants
        // upsert would then overwrite down to whichever child commits
        // last -- exactly the ambiguity this split exists to resolve, not
        // reintroduce.
        await tx.query(
          `INSERT INTO invoice_import_lines
             (org_id, invoice_import_id, line_no, split_from_line_id, raw_text, parsed_quantity,
              parsed_unit_cost, parsed_description, resolved_variant_id, status,
              resolved_by, resolved_at)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, 'matched', $9, now())`,
          [
            importId,
            nextLineNo++,
            lineId,
            line.raw_text,
            item.quantity,
            item.unit_cost ?? line.parsed_unit_cost,
            line.parsed_description,
            item.variant_id,
            actorUserId,
          ],
        );
      }

      await tx.query(
        `UPDATE invoice_import_lines
           SET status = 'split', resolved_variant_id = NULL, resolved_by = $2, resolved_at = now()
         WHERE id = $1`,
        [lineId, actorUserId],
      );

      await this.markReviewedIfDone(tx, importId);
      return this.loadImport(tx, importId);
    });
  }

  /**
   * Creates a brand-new product, or a new variant on an existing one,
   * straight from an unmatched line, and resolves the line to it -- all in
   * the review page, never a separate screen. `sku` is cross-checked
   * against the catalog first (this business treats SKU and UPC as the same
   * number): if it already resolves to something real, this just matches
   * the line to that variant instead of creating a duplicate.
   */
  async createProductForLine(
    orgId: string,
    actorUserId: string,
    importId: string,
    lineId: string,
    input: CreateProductForLine,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: importRows } = await tx.query<{ store_id: string }>(
        `SELECT store_id FROM invoice_imports WHERE id = $1`,
        [importId],
      );
      if (!importRows[0]) throw ApiException.notFound('invoice import');
      const storeId = importRows[0].store_id;

      await this.assertImportEditable(tx, importId);
      const line = await this.loadLineForUpdate(tx, importId, lineId);
      if (line.status === 'split') {
        throw new ApiException('validation_failed', 'this line was already split into variants', {
          retryable: false,
        });
      }

      const existing = await this.catalog.findVariantBySkuOrBarcodeTx(tx, input.sku);

      let variantId: string;
      let productId: string;
      let isNew: boolean;
      // What extra_variants[] falls back to when a row doesn't give its own
      // price -- the main variant's own resolved price, whichever branch
      // below produced it (explicit, defaulted-from-the-existing-product, or
      // required-for-a-new-product).
      let resolvedPrice = input.price_minor;

      if (existing) {
        variantId = existing.id;
        productId = await this.productIdForVariant(tx, existing.id);
        isNew = false;
      } else if (input.existing_product_id) {
        productId = input.existing_product_id;
        if (resolvedPrice === undefined) {
          const current = await this.currentPriceForProduct(tx, productId, storeId);
          if (current !== null) resolvedPrice = money(current);
        }
        const variant = await this.catalog.addVariantTx(tx, actorUserId, productId, {
          sku: input.sku,
          variant_name: input.variant_name,
          attributes: input.variant_name ? { flavor: input.variant_name } : {},
          cost: '0',
          case_quantity: 1,
          pack_quantity: 1,
          barcodes: [{ barcode: input.sku }],
          ...(resolvedPrice !== undefined ? { price_minor: resolvedPrice } : {}),
        });
        variantId = variant.id;
        isNew = true;
      } else {
        // Only checked here, never in the schema: whether this SKU is
        // genuinely new is exactly what the lookup above just answered, and
        // a schema can't perform that lookup itself -- see this schema's own
        // comment for why requiring these two fields up front would wrongly
        // block "type an already-known SKU, expect it to match."
        if (!input.product_name || input.price_minor === undefined) {
          throw new ApiException('validation_failed', 'a new product needs a name and a retail price', {
            retryable: false,
          });
        }

        const product = await this.catalog.createProductTx(
          tx,
          actorUserId,
          {
            name: input.product_name!,
            brand_name: input.brand_name,
            category_id: input.category_id,
            unit_type: 'each',
            variant_axes: input.variant_name ? ['flavor'] : [],
            tags: [],
            variants: [
              {
                sku: input.sku,
                variant_name: input.variant_name,
                attributes: input.variant_name ? { flavor: input.variant_name } : {},
                cost: '0',
                case_quantity: 1,
                pack_quantity: 1,
                barcodes: [{ barcode: input.sku }],
                price_minor: input.price_minor!,
              },
            ],
          },
          storeId,
        );
        variantId = product.variants[0]!.id;
        productId = product.id;
        isNew = true;
      }

      // More flavors/sizes of the same product, in the same submission.
      // A row whose own SKU already exists somewhere is left alone rather
      // than erroring the whole submission over one collided row.
      for (const extra of input.extra_variants ?? []) {
        const extraExisting = await this.catalog.findVariantBySkuOrBarcodeTx(tx, extra.sku);
        if (extraExisting) continue;

        await this.catalog.addVariantTx(tx, actorUserId, productId, {
          sku: extra.sku,
          variant_name: extra.variant_name,
          attributes: { flavor: extra.variant_name },
          cost: '0',
          case_quantity: 1,
          pack_quantity: 1,
          barcodes: [{ barcode: extra.sku }],
          price_minor: extra.price_minor ?? resolvedPrice,
        });
      }

      await tx.query(
        `UPDATE invoice_import_lines
           SET resolved_variant_id = $2, status = $3, resolved_by = $4, resolved_at = now()
         WHERE id = $1`,
        [lineId, variantId, isNew ? 'new_product' : 'matched', actorUserId],
      );

      await this.markReviewedIfDone(tx, importId);
      return this.loadImport(tx, importId);
    });
  }

  /**
   * "This is the same item under a different code" -- for a line the AI
   * matched by name but whose own vendor SKU didn't hit anything on file.
   * Records that code as an additional, non-primary barcode on the
   * suggested variant and resolves the line to it. Needs no request body:
   * everything it acts on (`parsed_vendor_sku`, `ai_suggested_variant_id`)
   * is already sitting on the line.
   */
  async addSecondaryBarcode(orgId: string, actorUserId: string, importId: string, lineId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertImportEditable(tx, importId);
      const line = await this.loadLineForUpdate(tx, importId, lineId);

      if (!line.ai_suggested_variant_id) {
        throw new ApiException(
          'validation_failed',
          'this line has no suggested match to attach a secondary SKU to',
          { retryable: false },
        );
      }
      if (!line.parsed_vendor_sku) {
        throw new ApiException('validation_failed', 'this line has no vendor SKU to add', { retryable: false });
      }

      await this.catalog.addBarcodeToVariantTx(tx, actorUserId, line.ai_suggested_variant_id, line.parsed_vendor_sku);

      await tx.query(
        `UPDATE invoice_import_lines
           SET resolved_variant_id = $2, status = 'matched', resolved_by = $3, resolved_at = now()
         WHERE id = $1`,
        [lineId, line.ai_suggested_variant_id, actorUserId],
      );

      await this.markReviewedIfDone(tx, importId);
      return this.loadImport(tx, importId);
    });
  }

  private async productIdForVariant(tx: PoolClient, variantId: string): Promise<string> {
    const { rows } = await tx.query<{ product_id: string }>(
      `SELECT product_id FROM product_variants WHERE id = $1`,
      [variantId],
    );
    return rows[0]!.product_id;
  }

  /** The product's default variant's current effective price at this store, or null if it isn't priced yet. */
  private async currentPriceForProduct(tx: PoolClient, productId: string, storeId: string): Promise<string | null> {
    const { rows } = await tx.query<{ price_minor: string | null }>(
      `SELECT pr.price_minor::text
       FROM product_variants v
       LEFT JOIN LATERAL (
         SELECT price_minor FROM variant_prices
         WHERE variant_id = v.id AND (store_id = $2 OR store_id IS NULL)
           AND kind = 'regular' AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())
         ORDER BY store_id NULLS LAST, effective_from DESC LIMIT 1
       ) pr ON true
       WHERE v.product_id = $1 AND v.is_default = true
       LIMIT 1`,
      [productId, storeId],
    );
    return rows[0]?.price_minor ?? null;
  }

  /**
   * Turns a fully reviewed import into a real purchase order and receipt --
   * the only place this whole system finally touches real stock and money,
   * and only because every line got there through a human's own resolve/
   * ignore/split action, never an AI suggestion by itself.
   *
   * No existing PO to reconcile against is the common case in this vertical
   * (per `docs/INTEGRATIONS.md`), so this synthesizes one from the resolved
   * lines and receives against it immediately, in the same transaction --
   * exactly the two calls `PurchasingService`'s own transactional refactor
   * was built to compose.
   */
  async commit(orgId: string, actorUserId: string, importId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: importRows } = await tx.query<{
        id: string;
        store_id: string;
        vendor_id: string | null;
        purchase_order_id: string | null;
        status: string;
        source_object_key: string;
        vendor_invoice_no: string | null;
        invoice_total_minor: string | null;
      }>(
        `SELECT id, store_id, vendor_id, purchase_order_id, status, source_object_key,
                vendor_invoice_no, invoice_total_minor::text
         FROM invoice_imports WHERE id = $1 FOR UPDATE`,
        [importId],
      );
      const invoiceImport = importRows[0];
      if (!invoiceImport) throw ApiException.notFound('invoice import');

      if (invoiceImport.status === 'committed') {
        throw new ApiException('conflict', 'this invoice was already committed', { retryable: false });
      }
      if (!invoiceImport.vendor_id) {
        throw new ApiException(
          'validation_failed',
          'this invoice has no vendor -- re-upload it with a vendor selected before committing',
          { retryable: false },
        );
      }

      const { rows: lines } = await tx.query<{
        id: string;
        status: string;
        resolved_variant_id: string | null;
        parsed_quantity: string | null;
        parsed_unit_cost: string | null;
        parsed_vendor_sku: string | null;
      }>(
        `SELECT id, status, resolved_variant_id, parsed_quantity::text, parsed_unit_cost::text, parsed_vendor_sku
         FROM invoice_import_lines WHERE invoice_import_id = $1 ORDER BY line_no`,
        [importId],
      );

      const pendingCount = lines.filter((l) => l.status === 'pending').length;
      if (pendingCount > 0) {
        throw new ApiException(
          'validation_failed',
          `${pendingCount} line(s) still need review -- resolve, ignore, or split each one before committing`,
          { retryable: false },
        );
      }

      const committable = lines.filter((l) => l.status === 'matched' || l.status === 'new_product');
      if (committable.length === 0) {
        throw new ApiException(
          'validation_failed',
          'nothing to commit -- every line was ignored or split with no lines left to receive',
          { retryable: false },
        );
      }
      for (const l of committable) {
        if (!l.resolved_variant_id || l.parsed_quantity == null || l.parsed_unit_cost == null) {
          throw new ApiException(
            'validation_failed',
            'a resolved line is missing a variant, quantity, or unit cost',
            { retryable: false },
          );
        }
      }

      if (invoiceImport.purchase_order_id) {
        throw new ApiException(
          'validation_failed',
          'committing against a pre-existing purchase order is not supported yet',
          { retryable: false },
        );
      }

      // Used as-is when the vendor's own invoice already has a number --
      // vendors format these however they like, often with their own
      // prefix already, and re-prefixing would just as often double one up
      // (an invoice numbered "INV-77042" becoming reference "INV-INV-77042").
      // The synthetic fallback only exists for an invoice with no number at
      // all, where nothing but this import's own id identifies it.
      const reference = invoiceImport.vendor_invoice_no ?? `INV-${importId.slice(0, 8)}`;

      const po = await this.purchasing.createPurchaseOrderTx(tx, actorUserId, {
        store_id: invoiceImport.store_id,
        vendor_id: invoiceImport.vendor_id,
        reference,
        lines: committable.map((l) => ({
          variant_id: l.resolved_variant_id!,
          vendor_sku: l.parsed_vendor_sku ?? undefined,
          quantity_ordered: l.parsed_quantity!,
          unit_cost: l.parsed_unit_cost!,
        })),
      });

      // `loadPurchaseOrder` sorts its lines by product/variant name for
      // display, not insertion order -- re-read directly, ordered by id
      // (UUIDv7, monotonic within this transaction), which matches the
      // order the loop above just inserted them in.
      const { rows: poLineRows } = await tx.query<{ id: string }>(
        `SELECT id FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY id`,
        [po.id],
      );

      await this.purchasing.receivePurchaseOrderTx(
        tx,
        actorUserId,
        po.id,
        {
          vendor_invoice_no: invoiceImport.vendor_invoice_no ?? undefined,
          lines: committable.map((l, i) => ({
            po_line_id: poLineRows[i]!.id,
            quantity_received: l.parsed_quantity!,
          })),
        },
        {
          // No presigned-URL generation exists in `ObjectStorageService` yet,
          // so this isn't a fetchable link -- but the object key is still
          // the correct, stable pointer back to the stored file.
          documentUrl: invoiceImport.source_object_key,
          invoiceTotalMinor: invoiceImport.invoice_total_minor ?? undefined,
        },
      );

      for (const l of committable) {
        if (l.parsed_vendor_sku) {
          await tx.query(
            `INSERT INTO vendor_variants (org_id, vendor_id, variant_id, vendor_sku, case_quantity, case_cost, last_ordered_at)
             VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, 1, $4, now())
             ON CONFLICT (vendor_id, vendor_sku) DO UPDATE
               SET variant_id = EXCLUDED.variant_id,
                   case_cost = $4::numeric * vendor_variants.case_quantity,
                   last_ordered_at = now()`,
            [invoiceImport.vendor_id, l.resolved_variant_id, l.parsed_vendor_sku, l.parsed_unit_cost],
          );
        }
      }

      await tx.query(
        `UPDATE invoice_imports SET status = 'committed', committed_at = now(), purchase_order_id = $2 WHERE id = $1`,
        [importId, po.id],
      );

      return this.loadImport(tx, importId);
    });
  }

  private async markReviewedIfDone(tx: PoolClient, importId: string): Promise<void> {
    await tx.query(
      `UPDATE invoice_imports SET status = 'reviewed'
       WHERE id = $1 AND status = 'parsed'
         AND NOT EXISTS (
           SELECT 1 FROM invoice_import_lines WHERE invoice_import_id = $1 AND status = 'pending'
         )`,
      [importId],
    );
  }

  private async loadLineForUpdate(tx: PoolClient, importId: string, lineId: string) {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      raw_text: string;
      parsed_quantity: string | null;
      parsed_unit_cost: string | null;
      parsed_description: string | null;
      parsed_vendor_sku: string | null;
      ai_suggested_variant_id: string | null;
    }>(
      `SELECT id, status, raw_text, parsed_quantity::text, parsed_unit_cost::text, parsed_description,
              parsed_vendor_sku, ai_suggested_variant_id
       FROM invoice_import_lines WHERE id = $1 AND invoice_import_id = $2 FOR UPDATE`,
      [lineId, importId],
    );
    const line = rows[0];
    if (!line) throw ApiException.notFound('invoice import line');
    return line;
  }

  private async assertImportEditable(tx: PoolClient, importId: string): Promise<void> {
    const { rows } = await tx.query<{ status: string }>(`SELECT status FROM invoice_imports WHERE id = $1`, [
      importId,
    ]);
    if (!rows[0]) throw ApiException.notFound('invoice import');
    if (rows[0].status === 'committed') {
      throw new ApiException('conflict', 'this invoice was already committed and can no longer be edited', {
        retryable: false,
      });
    }
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
