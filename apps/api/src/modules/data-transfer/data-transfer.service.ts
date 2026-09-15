import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { money, type CreateProduct, type ImportEntity, type ImportRowIssue } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { AiService } from '../../platform/ai/ai.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import {
  readTable,
  headerHash,
  formatFor,
  MAX_IMPORT_ROWS,
  type TabularFormat,
  type TabularTable,
} from '../../platform/tabular/tabular.js';
import { fieldsFor, mapColumnsDeterministically, sanitizeMapping } from './column-mapping.js';

const JOB_COLUMNS = `id, entity, store_id, source_filename, source_format, headers, mapping,
       ai_mapped_fields, row_count, status, dry_run, error, created_at, committed_at`;

/** How many issues a dry run reports. A file with 4,000 bad rows does not need 4,000 messages to make its point. */
const MAX_ISSUES = 100;

/** How many mapped rows the review screen previews. */
const SAMPLE_ROWS = 5;

/** How many raw rows the AI mapper sees. Enough to judge a column by its values; not enough to be an export. */
const AI_SAMPLE_ROWS = 4;

interface ItemRow {
  sku: string;
  name: string | null;
  variant_name: string | null;
  brand: string | null;
  category: string | null;
  price_minor: string | null;
  cost: string | null;
  case_cost: string | null;
  case_quantity: string | null;
  plu: string | null;
  vendor_sku: string | null;
  reorder_point: string | null;
}

interface CustomerRow {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  birth_month: number | null;
  birth_day: number | null;
  tags: string[];
  notes: string | null;
}

/**
 * Spreadsheets in, spreadsheets out.
 *
 * The one rule the whole import path is built around: **nothing is written
 * until a dry run has been reviewed.** Upload proposes a mapping, dry run
 * validates every row and reports what would happen, and commit is refused
 * unless a dry run for the current mapping exists. A single "import this
 * file" call would be shorter and is exactly the shape that lets a wrong
 * column mapping corrupt a whole catalog before anyone can see it -- which
 * is the realistic failure for the migration this is mostly built for.
 *
 * Validation and writing deliberately share one function per entity
 * (`readItemRow`/`readCustomerRow`): a dry run that validates differently
 * from the commit is worse than no dry run, because it is trusted.
 */
@Injectable()
export class DataTransferService {
  private readonly logger = new Logger(DataTransferService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
    private readonly ai: AiService,
    private readonly catalog: CatalogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  /**
   * Store the file, read its header row, and propose a mapping.
   *
   * The proposal comes from, in order: a mapping someone already confirmed
   * for this exact header shape, then deterministic alias matching, then AI
   * for whatever is still unplaced. A remembered layout short-circuits the
   * other two entirely -- that is the point of remembering it.
   */
  async createImport(
    orgId: string,
    actorUserId: string,
    input: { entity: ImportEntity; store_id?: string | undefined },
    file: { buffer: Buffer; filename: string; contentType: string },
  ) {
    const format = formatFor(file.contentType, file.filename);
    if (!format) {
      throw new ApiException(
        'validation_failed',
        `"${file.filename}" isn't a spreadsheet this can read -- save it as .csv or .xlsx and try again`,
        { retryable: false },
      );
    }

    let table: TabularTable;
    try {
      table = await readTable(file.buffer, format);
    } catch (e) {
      throw new ApiException(
        'validation_failed',
        `could not read that file: ${e instanceof Error ? e.message : 'unknown error'}`,
        { retryable: false },
      );
    }

    if (table.headers.length === 0 || table.rows.length === 0) {
      throw new ApiException(
        'validation_failed',
        'that file has no rows in it -- the first row should be column headings, with the data underneath',
        { retryable: false },
      );
    }
    if (table.rows.length > MAX_IMPORT_ROWS) {
      throw new ApiException(
        'validation_failed',
        `that file has ${table.rows.length.toLocaleString()} rows; ${MAX_IMPORT_ROWS.toLocaleString()} is the most one import can carry -- split it and run it in parts`,
        { retryable: false },
      );
    }

    const hash = headerHash(table.headers);
    const objectKey = `${orgId}/imports/${randomUUID()}-${file.filename}`;
    await this.storage.put(objectKey, file.buffer, file.contentType);

    const proposal = await this.proposeMapping(orgId, input.entity, table, hash);

    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO import_jobs
           (org_id, entity, store_id, source_object_key, source_filename, source_content_type,
            source_format, header_hash, headers, mapping, ai_mapped_fields, row_count, status, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
         RETURNING id`,
        [
          input.entity,
          input.store_id ?? null,
          objectKey,
          file.filename,
          file.contentType,
          format,
          hash,
          JSON.stringify(table.headers),
          JSON.stringify(proposal.mapping),
          JSON.stringify(proposal.aiMappedFields),
          table.rows.length,
          Object.keys(proposal.mapping).length > 0 ? 'mapped' : 'uploaded',
          actorUserId,
        ],
      );

      return this.loadJobForClient(tx, rows[0]!.id);
    });
  }

  /**
   * Three tiers, cheapest first. A remembered layout wins outright; otherwise
   * the deterministic pass runs and AI is asked only about what it could not
   * place, and only offered the columns nothing claimed.
   *
   * An AI failure is swallowed on purpose: a mapping is a proposal a human is
   * about to review anyway, so an unreachable or unconfigured model should
   * leave those fields blank for them to fill in, not fail the upload of a
   * file that was read perfectly well.
   */
  private async proposeMapping(
    orgId: string,
    entity: ImportEntity,
    table: TabularTable,
    hash: string,
  ): Promise<{ mapping: Record<string, string>; aiMappedFields: string[]; reused: boolean }> {
    const saved = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ mapping: Record<string, unknown> }>(
        `UPDATE import_mappings SET use_count = use_count + 1, last_used_at = now()
         WHERE entity = $1 AND header_hash = $2
         RETURNING mapping`,
        [entity, hash],
      );
      return rows[0]?.mapping ?? null;
    });

    if (saved) {
      return { mapping: sanitizeMapping(entity, table.headers, saved), aiMappedFields: [], reused: true };
    }

    const deterministic = mapColumnsDeterministically(entity, table.headers);
    if (deterministic.unmapped.length === 0 || deterministic.unusedColumns.length === 0) {
      return { mapping: deterministic.mapping, aiMappedFields: [], reused: false };
    }
    if (!this.ai.isConfigured()) {
      return { mapping: deterministic.mapping, aiMappedFields: [], reused: false };
    }

    const fields = fieldsFor(entity);
    const asked = deterministic.unmapped
      .map((key) => fields.find((f) => f.key === key))
      .filter((f): f is (typeof fields)[number] => f !== undefined)
      .map((f) => ({ key: f.key, label: f.label, hint: f.hint }));

    try {
      const guesses = await this.ai.mapColumns({
        entity,
        fields: asked,
        columns: deterministic.unusedColumns,
        sample_rows: table.rows.slice(0, AI_SAMPLE_ROWS),
      });

      const merged = { ...deterministic.mapping };
      const aiMappedFields: string[] = [];
      for (const guess of guesses) {
        // Only fields actually asked about, and only columns actually
        // offered -- a model naming a column that doesn't exist would read as
        // `undefined` on every row, and one naming a claimed column would
        // silently steal it from the field that legitimately matched.
        if (!guess.column || !deterministic.unmapped.includes(guess.field)) continue;
        if (!deterministic.unusedColumns.includes(guess.column)) continue;
        if (Object.values(merged).includes(guess.column)) continue;
        merged[guess.field] = guess.column;
        aiMappedFields.push(guess.field);
      }
      return { mapping: sanitizeMapping(entity, table.headers, merged), aiMappedFields, reused: false };
    } catch (e) {
      this.logger.warn(`column mapping via AI failed, falling back to the deterministic mapping: ${String(e)}`);
      return { mapping: deterministic.mapping, aiMappedFields: [], reused: false };
    }
  }

  async listImports(orgId: string, entity?: ImportEntity) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${JOB_COLUMNS} FROM import_jobs
         WHERE ($1::text IS NULL OR entity::text = $1)
         ORDER BY created_at DESC LIMIT 50`,
        [entity ?? null],
      );
      return rows;
    });
  }

  async getImport(orgId: string, id: string) {
    return this.db.withOrg(orgId, (tx) => this.loadJobForClient(tx, id));
  }

  /**
   * Replace the proposed mapping with the one a human confirmed. Clears the
   * previous dry run: a mapping that changed invalidates the counts it
   * produced, and leaving them would let someone commit against a review of
   * something else.
   */
  async setMapping(
    orgId: string,
    actorUserId: string,
    id: string,
    input: { mapping: Record<string, string>; remember?: boolean | undefined },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const job = await this.loadJobForUpdate(tx, id);
      const mapping = sanitizeMapping(job.entity, job.headers, input.mapping);

      await tx.query(
        `UPDATE import_jobs
           SET mapping = $2::jsonb, status = 'mapped', dry_run = NULL, ai_mapped_fields = '[]'::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(mapping)],
      );

      if (input.remember) {
        await tx.query(
          `INSERT INTO import_mappings (org_id, entity, header_hash, headers, mapping, label, created_by)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3::jsonb, $4::jsonb, $5, $6)
           ON CONFLICT (org_id, entity, header_hash)
           DO UPDATE SET mapping = EXCLUDED.mapping, last_used_at = now()`,
          [
            job.entity,
            job.header_hash,
            JSON.stringify(job.headers),
            JSON.stringify(mapping),
            job.source_filename,
            actorUserId,
          ],
        );
      }

      return this.loadJobForClient(tx, id);
    });
  }

  /**
   * Validate every row against the current mapping and report what committing
   * would do -- without writing anything.
   *
   * Runs inside a transaction that is deliberately never committed for the
   * writes it would make; it only reads. Existence checks (does this SKU
   * exist? does this category?) are real lookups against the live catalog,
   * because "would this row create or update something" cannot be answered
   * any other way.
   */
  async dryRun(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const job = await this.loadJobForUpdate(tx, id);
      if (job.status === 'committed') {
        throw new ApiException('conflict', 'this import was already committed', { retryable: false });
      }

      const table = await this.readJobTable(job);
      const result =
        job.entity === 'item'
          ? await this.planItems(tx, job, table)
          : await this.planCustomers(tx, job, table);

      await tx.query(`UPDATE import_jobs SET dry_run = $2::jsonb, status = 'validated' WHERE id = $1`, [
        id,
        JSON.stringify(result),
      ]);

      return this.loadJobForClient(tx, id);
    });
  }

  /**
   * Apply the import, in one transaction.
   *
   * Refused unless the job is `validated` -- that is what makes the dry run
   * mandatory rather than merely available, and it is why commit takes no
   * mapping of its own: the mapping that runs is the one that was reviewed.
   *
   * A row that fails here is skipped and reported rather than failing the
   * whole import, with one exception: an error that isn't about a single row
   * (a lost connection, a constraint nobody anticipated) propagates and rolls
   * everything back, because a half-applied catalog migration is worse than
   * none.
   */
  async commitImport(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const job = await this.loadJobForUpdate(tx, id);
      if (job.status === 'committed') {
        throw new ApiException('conflict', 'this import was already committed', { retryable: false });
      }
      if (job.status !== 'validated') {
        throw new ApiException(
          'validation_failed',
          'run a dry run and review what it reports before committing this import',
          { retryable: false },
        );
      }

      const table = await this.readJobTable(job);
      const result =
        job.entity === 'item'
          ? await this.writeItems(tx, actorUserId, job, table)
          : await this.writeCustomers(tx, actorUserId, job, table);

      await tx.query(
        `UPDATE import_jobs SET status = 'committed', committed_at = now(), dry_run = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify({ ...(job.dry_run ?? {}), ...result })],
      );

      await this.audit.record(tx, {
        action: 'import.commit',
        entityType: 'import_job',
        entityId: id,
        actorUserId,
        newValue: {
          entity: job.entity,
          filename: job.source_filename,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
        },
      });

      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  /**
   * Validation and the write share this, so a dry run cannot disagree with
   * what the commit actually does. `lookup` answers whether a SKU already
   * exists; in a dry run that is a read, in a commit it is the same read.
   */
  private async planItems(tx: PoolClient, job: JobRow, table: TabularTable) {
    const issues: ImportRowIssue[] = [];
    const sample: Record<string, string>[] = [];
    let create = 0;
    let update = 0;

    const seenSkus = new Set<string>();
    // Categories named in the file that don't exist here. Those rows still
    // import, uncategorized -- worth saying out loud, because a migration
    // whose departments don't line up produces four thousand items with no
    // category and no error to explain it.
    const unknownCategories = new Set<string>();

    for (const [index, raw] of table.rows.entries()) {
      const rowNumber = index + 1;
      const parsed = this.readItemRow(job.mapping, raw);
      if (typeof parsed === 'string') {
        issues.push({ row_number: rowNumber, message: parsed, identifier: null });
        continue;
      }

      if (parsed.category && !(await this.findCategoryTx(tx, parsed.category))) {
        unknownCategories.add(parsed.category);
      }

      if (seenSkus.has(parsed.sku.toUpperCase())) {
        issues.push({
          row_number: rowNumber,
          message: `SKU ${parsed.sku} appears more than once in this file — only the first row for it would be used`,
          identifier: parsed.sku,
        });
        continue;
      }
      seenSkus.add(parsed.sku.toUpperCase());

      const existing = await this.catalog.findVariantBySkuOrBarcodeTx(tx, parsed.sku);
      if (existing) {
        update += 1;
      } else if (!parsed.name) {
        issues.push({
          row_number: rowNumber,
          message: `SKU ${parsed.sku} isn't in the catalog yet, and this row has no product name to create it with`,
          identifier: parsed.sku,
        });
        continue;
      } else {
        create += 1;
      }

      if (sample.length < SAMPLE_ROWS) sample.push(this.describeItem(parsed, Boolean(existing)));
    }

    const warnings: string[] = [];
    if (unknownCategories.size > 0) {
      const names = [...unknownCategories].slice(0, 10).join(', ');
      const more = unknownCategories.size > 10 ? ', …' : '';
      const subject =
        unknownCategories.size === 1
          ? `One category named in this file doesn't exist here`
          : `${unknownCategories.size} categories named in this file don't exist here`;
      warnings.push(
        `${subject} (${names}${more}). Those items will import without a category — create the categories first if you want them sorted.`,
      );
    }

    return {
      total_rows: table.rows.length,
      create_count: create,
      update_count: update,
      skip_count: issues.length,
      issues: issues.slice(0, MAX_ISSUES),
      ignored_columns: table.headers.filter((h) => !Object.values(job.mapping).includes(h)),
      warnings,
      sample,
    };
  }

  private async writeItems(tx: PoolClient, actorUserId: string, job: JobRow, table: TabularTable) {
    const issues: ImportRowIssue[] = [];
    let created = 0;
    let updated = 0;
    const seenSkus = new Set<string>();

    for (const [index, raw] of table.rows.entries()) {
      const rowNumber = index + 1;
      const parsed = this.readItemRow(job.mapping, raw);
      if (typeof parsed === 'string') {
        issues.push({ row_number: rowNumber, message: parsed, identifier: null });
        continue;
      }
      if (seenSkus.has(parsed.sku.toUpperCase())) {
        issues.push({
          row_number: rowNumber,
          message: `SKU ${parsed.sku} appears more than once in this file — this row was skipped`,
          identifier: parsed.sku,
        });
        continue;
      }
      seenSkus.add(parsed.sku.toUpperCase());

      const existing = await this.catalog.findVariantBySkuOrBarcodeTx(tx, parsed.sku);
      if (existing) {
        await this.updateItemRow(tx, actorUserId, job, existing.id, parsed);
        updated += 1;
        continue;
      }
      if (!parsed.name) {
        issues.push({
          row_number: rowNumber,
          message: `SKU ${parsed.sku} isn't in the catalog yet, and this row has no product name to create it with`,
          identifier: parsed.sku,
        });
        continue;
      }
      await this.createItemRow(tx, actorUserId, job, parsed);
      created += 1;
    }

    return { created, updated, skipped: issues.length, issues: issues.slice(0, MAX_ISSUES) };
  }

  private async createItemRow(tx: PoolClient, actorUserId: string, job: JobRow, row: ItemRow) {
    const categoryId = row.category ? await this.findCategoryTx(tx, row.category) : null;

    const variant: CreateProduct['variants'][number] = {
      sku: row.sku,
      attributes: {},
      // The SKU doubles as the scannable code, the same thing invoice-line
      // product creation does and for the same reason: this business treats a
      // SKU and a UPC as one number, and `scan` reads `variant_barcodes` --
      // an item with no barcode row cannot be rung up at all. A SKU that
      // isn't barcode-shaped (too short, or carrying characters a scanner
      // never produces) gets none, and `isBarcodeShaped` is what decides.
      barcodes: isBarcodeShaped(row.sku) ? [{ barcode: row.sku, is_primary: true }] : [],
      cost: row.cost ?? '0',
      case_quantity: row.case_quantity ? Number(row.case_quantity) : 1,
      pack_quantity: 1,
      ...(row.variant_name ? { variant_name: row.variant_name } : {}),
      ...(row.reorder_point ? { reorder_point: row.reorder_point } : {}),
      ...(row.price_minor ? { price_minor: money(row.price_minor) } : {}),
    };

    await this.catalog.createProductTx(
      tx,
      actorUserId,
      {
        name: row.name!,
        unit_type: 'each',
        variant_axes: [],
        tags: [],
        ...(row.brand ? { brand_name: row.brand } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
        variants: [variant],
      },
      job.store_id,
    );
  }

  /**
   * An update touches only what the sheet actually carried. A price list with
   * a cost column and nothing else must not blank out a name, and `COALESCE`
   * per column is what guarantees that -- the same rule every other update
   * path in this API follows.
   *
   * The price goes through `CatalogService.closeAndOpenPrice` rather than an
   * UPDATE, so a bulk price change is effective-dated and shows up in the
   * item's price history exactly like one typed on its own page.
   */
  private async updateItemRow(tx: PoolClient, actorUserId: string, job: JobRow, variantId: string, row: ItemRow) {
    await tx.query(
      `UPDATE product_variants SET
         variant_name  = COALESCE($2, variant_name),
         plu           = COALESCE($3, plu),
         case_quantity = COALESCE($4::int, case_quantity),
         case_cost     = COALESCE($5::numeric, case_cost),
         reorder_point = COALESCE($6::numeric, reorder_point),
         cost = CASE
                  WHEN COALESCE($5::numeric, case_cost) IS NOT NULL
                    THEN COALESCE($5::numeric, case_cost)
                         / GREATEST(COALESCE($4::int, case_quantity), 1)
                  ELSE COALESCE($7::numeric, cost)
                END
       WHERE id = $1`,
      [
        variantId,
        row.variant_name,
        row.plu,
        row.case_quantity,
        row.case_cost,
        row.reorder_point,
        row.cost,
      ],
    );

    if (row.price_minor !== null) {
      const { rows: current } = await tx.query<{ price_minor: string | null }>(
        `SELECT price_minor::text FROM variant_prices
         WHERE variant_id = $1 AND kind = 'regular' AND effective_to IS NULL
           AND (store_id = $2 OR store_id IS NULL)
         ORDER BY store_id NULLS LAST LIMIT 1`,
        [variantId, job.store_id],
      );
      // Only when it actually changed: re-stamping an identical price would
      // fill the history with rows saying nothing happened.
      if (current[0]?.price_minor !== row.price_minor) {
        await this.catalog.closeAndOpenPrice(tx, actorUserId, variantId, job.store_id, row.price_minor);
      }
    }

    if (row.name) {
      await tx.query(
        `UPDATE products SET name = $2 WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`,
        [variantId, row.name],
      );
    }
  }

  /**
   * One spreadsheet row to an item, or a sentence saying why it can't be.
   *
   * Returning the message rather than throwing is what lets one bad row be
   * reported and skipped while the rest of a 4,000-row migration goes in.
   */
  private readItemRow(mapping: Record<string, string>, raw: Record<string, string>): ItemRow | string {
    const value = (field: string): string | null => {
      const column = mapping[field];
      if (!column) return null;
      const text = (raw[column] ?? '').trim();
      return text === '' ? null : text;
    };

    const sku = value('sku');
    if (!sku) return 'no SKU in this row';
    if (sku.length > 64) return `that SKU is ${sku.length} characters; 64 is the most allowed`;

    const priceText = value('price');
    const priceMinor = priceText === null ? null : majorToMinor(priceText);
    if (priceText !== null && priceMinor === null) return `"${priceText}" isn't a price this can read`;

    const cost = readDecimal(value('cost'));
    if (cost === false) return `"${value('cost')}" isn't a cost this can read`;
    const caseCost = readDecimal(value('case_cost'));
    if (caseCost === false) return `"${value('case_cost')}" isn't a case cost this can read`;
    const reorder = readDecimal(value('reorder_point'));
    if (reorder === false) return `"${value('reorder_point')}" isn't a reorder point this can read`;

    const caseQtyText = value('case_quantity');
    let caseQuantity: string | null = null;
    if (caseQtyText !== null) {
      const parsedQty = Number(caseQtyText.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(parsedQty) || parsedQty < 1) return `"${caseQtyText}" isn't a number of units per case`;
      caseQuantity = String(Math.round(parsedQty));
    }

    return {
      sku,
      name: value('name'),
      variant_name: value('variant_name'),
      brand: value('brand'),
      category: value('category'),
      price_minor: priceMinor,
      cost,
      case_cost: caseCost,
      case_quantity: caseQuantity,
      plu: value('plu'),
      vendor_sku: value('vendor_sku'),
      reorder_point: reorder,
    };
  }

  private describeItem(row: ItemRow, existing: boolean): Record<string, string> {
    const described: Record<string, string> = {
      action: existing ? 'update' : 'create',
      sku: row.sku,
    };
    if (row.name) described.name = row.name;
    if (row.variant_name) described.variant = row.variant_name;
    if (row.brand) described.brand = row.brand;
    if (row.category) described.category = row.category;
    if (row.price_minor) described.price = formatMinor(row.price_minor);
    if (row.cost) described.cost = `$${row.cost}`;
    if (row.case_cost) described.case_cost = `$${row.case_cost}`;
    if (row.case_quantity) described.units_per_case = row.case_quantity;
    return described;
  }

  private async findCategoryTx(tx: PoolClient, name: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM categories WHERE lower(name) = lower($1) AND status = 'active' LIMIT 1`,
      [name],
    );
    return rows[0]?.id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------

  private async planCustomers(tx: PoolClient, job: JobRow, table: TabularTable) {
    const issues: ImportRowIssue[] = [];
    const sample: Record<string, string>[] = [];
    let create = 0;
    let update = 0;
    const seen = new Set<string>();

    const mapping = job.mapping;
    for (const [index, raw] of table.rows.entries()) {
      const rowNumber = index + 1;
      const parsed = this.readCustomerRow(mapping, raw);
      if (typeof parsed === 'string') {
        issues.push({ row_number: rowNumber, message: parsed, identifier: null });
        continue;
      }

      const key = (parsed.phone ?? parsed.email ?? '').toLowerCase();
      if (seen.has(key)) {
        issues.push({
          row_number: rowNumber,
          message: `${key} appears more than once in this file — this row was skipped`,
          identifier: key,
        });
        continue;
      }
      seen.add(key);

      const existing = await this.findCustomerTx(tx, parsed.phone, parsed.email);
      if (existing) update += 1;
      else create += 1;

      if (sample.length < SAMPLE_ROWS) {
        sample.push({
          action: existing ? 'update' : 'create',
          name: [parsed.first_name, parsed.last_name].filter(Boolean).join(' ') || '—',
          phone: parsed.phone ?? '—',
          email: parsed.email ?? '—',
          ...(parsed.birth_month ? { birthday: `${parsed.birth_month}/${parsed.birth_day}` } : {}),
          ...(parsed.tags.length ? { tags: parsed.tags.join(', ') } : {}),
        });
      }
    }

    return {
      total_rows: table.rows.length,
      create_count: create,
      update_count: update,
      skip_count: issues.length,
      issues: issues.slice(0, MAX_ISSUES),
      ignored_columns: table.headers.filter((h) => !Object.values(mapping).includes(h)),
      // Imported customers never arrive opted in, and that is worth saying
      // on the screen where someone is about to import a list -- see
      // `writeCustomers` for why.
      warnings: [
        `Imported customers are not opted in to marketing. A spreadsheet isn't consent — they can be looked up and can buy, but nothing will be sent to them until they opt in.`,
      ],
      sample,
    };
  }

  /**
   * Imported customers arrive with **no consent row**, deliberately.
   *
   * `customer_consents.source` includes `'import'`, which makes it look like
   * a spreadsheet could establish consent. It cannot: CAN-SPAM and the TCPA
   * both need express opt-in from the person, and treating a purchased or
   * inherited list as opted-in is precisely how a shop gets fined. These
   * customers can be looked up at the register and can buy; they cannot be
   * marketed to until someone opts in for real.
   */
  private async writeCustomers(tx: PoolClient, actorUserId: string, job: JobRow, table: TabularTable) {
    const issues: ImportRowIssue[] = [];
    let created = 0;
    let updated = 0;
    const seen = new Set<string>();
    const mapping = job.mapping;

    for (const [index, raw] of table.rows.entries()) {
      const rowNumber = index + 1;
      const parsed = this.readCustomerRow(mapping, raw);
      if (typeof parsed === 'string') {
        issues.push({ row_number: rowNumber, message: parsed, identifier: null });
        continue;
      }
      const key = (parsed.phone ?? parsed.email ?? '').toLowerCase();
      if (seen.has(key)) {
        issues.push({
          row_number: rowNumber,
          message: `${key} appears more than once in this file — this row was skipped`,
          identifier: key,
        });
        continue;
      }
      seen.add(key);

      const existing = await this.findCustomerTx(tx, parsed.phone, parsed.email);
      if (existing) {
        await tx.query(
          `UPDATE customers SET
             first_name  = COALESCE($2, first_name),
             last_name   = COALESCE($3, last_name),
             phone       = COALESCE($4, phone),
             email       = COALESCE($5, email),
             birth_month = COALESCE($6, birth_month),
             birth_day   = COALESCE($7, birth_day),
             notes       = COALESCE($8, notes),
             tags        = CASE WHEN $9::text[] IS NULL THEN tags
                                ELSE (SELECT array_agg(DISTINCT t) FROM unnest(tags || $9::text[]) t) END
           WHERE id = $1`,
          [
            existing,
            parsed.first_name,
            parsed.last_name,
            parsed.phone,
            parsed.email,
            parsed.birth_month,
            parsed.birth_day,
            parsed.notes,
            parsed.tags.length ? parsed.tags : null,
          ],
        );
        updated += 1;
        continue;
      }

      await tx.query(
        `INSERT INTO customers
           (org_id, first_name, last_name, phone, email, birth_month, birth_day, notes, tags)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7, COALESCE($8::text[], '{}'))`,
        [
          parsed.first_name,
          parsed.last_name,
          parsed.phone,
          parsed.email,
          parsed.birth_month,
          parsed.birth_day,
          parsed.notes,
          parsed.tags.length ? parsed.tags : null,
        ],
      );
      created += 1;
    }

    await this.audit.record(tx, {
      action: 'customer.import',
      entityType: 'customer',
      actorUserId,
      newValue: { created, updated, skipped: issues.length, consent_granted: false },
    });

    return { created, updated, skipped: issues.length, issues: issues.slice(0, MAX_ISSUES) };
  }

  private readCustomerRow(mapping: Record<string, string>, raw: Record<string, string>): CustomerRow | string {
    const value = (field: string): string | null => {
      const column = mapping[field];
      if (!column) return null;
      const text = (raw[column] ?? '').trim();
      return text === '' ? null : text;
    };

    let firstName = value('first_name');
    let lastName = value('last_name');
    const fullName = value('full_name');
    if (!firstName && !lastName && fullName) {
      // Split on the LAST space: "Mary Jo Van Der Berg" is far more likely to
      // be a long surname than a long given name, and a one-word entry is a
      // first name rather than half of nothing.
      const cut = fullName.lastIndexOf(' ');
      if (cut === -1) firstName = fullName;
      else {
        firstName = fullName.slice(0, cut).trim();
        lastName = fullName.slice(cut + 1).trim();
      }
    }

    const phone = normalizePhone(value('phone'));
    if (phone === false) return `"${value('phone')}" isn't a phone number this can read`;
    const emailRaw = value('email');
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return `"${emailRaw}" isn't an email address`;

    if (!phone && !email) return 'no phone number and no email — a customer needs one of the two to be found again';

    const birthday = readBirthday(value('birthday'));
    if (birthday === false) return `"${value('birthday')}" isn't a date this can read`;

    const tagsRaw = value('tags');
    const tags = tagsRaw
      ? tagsRaw
          .split(/[,;|]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];

    return {
      first_name: firstName,
      last_name: lastName,
      phone,
      email,
      birth_month: birthday?.month ?? null,
      birth_day: birthday?.day ?? null,
      tags,
      notes: value('notes'),
    };
  }

  /**
   * Matched on phone first, then email -- the same order the register looks
   * someone up in. An anonymized customer is excluded: that row has had its
   * identity deliberately removed, and re-attaching a name to it from a
   * spreadsheet would undo the erasure.
   */
  private async findCustomerTx(tx: PoolClient, phone: string | null, email: string | null): Promise<string | null> {
    if (phone) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE phone = $1 AND anonymized_at IS NULL LIMIT 1`,
        [phone],
      );
      if (rows[0]) return rows[0].id;
    }
    if (email) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM customers WHERE lower(email) = $1 AND anonymized_at IS NULL LIMIT 1`,
        [email],
      );
      if (rows[0]) return rows[0].id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  /**
   * The catalog as a file.
   *
   * Column order and naming match what the importer's own aliases recognize,
   * so an export can be edited in Excel and imported straight back -- the
   * round trip is the point, not a coincidence. `sku` comes first for the
   * same reason: it is what the importer matches on.
   *
   * Cost columns are included, which is why this sits behind
   * `product.export` rather than `product.view`.
   */
  async exportItems(orgId: string, filter: { q?: string | undefined; status?: string | undefined }) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT v.sku,
                p.name,
                v.variant_name,
                b.name  AS brand,
                c.name  AS category,
                pr.price_minor::text AS price_minor,
                v.cost::text,
                v.case_cost::text,
                v.case_quantity::text,
                v.plu,
                v.reorder_point::text,
                v.status::text
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id AND kind = 'regular' AND effective_to IS NULL
           ORDER BY store_id NULLS LAST LIMIT 1
         ) pr ON true
         WHERE v.status = COALESCE($2, 'active')::entity_status
           AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR v.sku ILIKE '%' || $1 || '%')
         ORDER BY p.name, v.sort_order`,
        [filter.q?.trim() || null, filter.status ?? null],
      );

      const headers = [
        'SKU', 'Product name', 'Variant', 'Brand', 'Category',
        'Retail price', 'Unit cost', 'Case cost', 'Units per case', 'PLU', 'Reorder point', 'Status',
      ];
      const data = rows.map((r) => [
        r.sku ?? '',
        r.name ?? '',
        r.variant_name ?? '',
        r.brand ?? '',
        r.category ?? '',
        // Dollars, not minor units: this file is for a person to read and
        // edit, and the importer parses dollars back on the way in.
        r.price_minor ? minorToMajor(r.price_minor) : '',
        r.cost ? trimDecimal(r.cost) : '',
        r.case_cost ? trimDecimal(r.case_cost) : '',
        r.case_quantity ?? '',
        r.plu ?? '',
        r.reorder_point ? trimDecimal(r.reorder_point) : '',
        r.status ?? '',
      ]);
      return { headers, rows: data };
    });
  }

  /**
   * Customers as a file. Anonymized rows are excluded outright: those had
   * their identity deliberately erased, and an export is precisely the way
   * that erasure would be undone.
   */
  async exportCustomers(orgId: string, filter: { q?: string | undefined; status?: string | undefined }) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT first_name, last_name, phone, email,
                birth_month::text, birth_day::text,
                array_to_string(tags, ', ') AS tags,
                notes, status::text, created_at::text
         FROM customers
         WHERE status = COALESCE($2, 'active')::entity_status
           AND anonymized_at IS NULL
           AND ($1::text IS NULL OR first_name ILIKE '%' || $1 || '%' OR last_name ILIKE '%' || $1 || '%'
                OR phone ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
         ORDER BY last_name NULLS LAST, first_name NULLS LAST`,
        [filter.q?.trim() || null, filter.status ?? null],
      );

      const headers = ['First name', 'Last name', 'Phone', 'Email', 'Birthday', 'Tags', 'Notes', 'Status', 'Added'];
      const data = rows.map((r) => [
        r.first_name ?? '',
        r.last_name ?? '',
        r.phone ?? '',
        r.email ?? '',
        r.birth_month && r.birth_day ? `${r.birth_month}/${r.birth_day}` : '',
        r.tags ?? '',
        r.notes ?? '',
        r.status ?? '',
        (r.created_at ?? '').slice(0, 10),
      ]);
      return { headers, rows: data };
    });
  }

  /**
   * Exports are audited. Who walked out with the whole customer list, and
   * when, is exactly the question `customer.export` exists to be able to
   * answer after the fact.
   */
  async recordExport(orgId: string, actorUserId: string, entity: string, rowCount: number, format: string) {
    await this.audit.recordStandalone(orgId, {
      action: `${entity}.export`,
      entityType: entity,
      actorUserId,
      newValue: { row_count: rowCount, format },
    });
  }

  // ---------------------------------------------------------------------------
  // Shared plumbing
  // ---------------------------------------------------------------------------

  private async readJobTable(job: JobRow): Promise<TabularTable> {
    const buffer = await this.storage.get(job.source_object_key);
    return readTable(buffer, job.source_format as TabularFormat);
  }

  /**
   * The job as the review screen needs it: the row, plus the entity's field
   * list, plus whether this mapping is one already saved for this layout.
   *
   * Every endpoint the review screen calls returns this same shape. They used
   * not to -- `getImport` was enriched while `setMapping` and `dryRun`
   * returned the bare row -- and the client replaced its state with whatever
   * came back, so running a dry run made the entire mapping section vanish
   * and the "saved layout" note revert. A response shape that depends on
   * which endpoint produced it is a trap for exactly that reason.
   *
   * `reused_saved_mapping` is derived rather than stored, because uploading
   * redirects to a fresh fetch of the job: a flag returned only from
   * `createImport` would never reach anyone. Comparing the job's mapping to
   * the saved one answers the same question at any point, and stays right if
   * the layout is saved later.
   */
  private async loadJobForClient(tx: PoolClient, id: string) {
    const job = await this.loadJob(tx, id);
    const { rows } = await tx.query<{ mapping: Record<string, string> }>(
      `SELECT mapping FROM import_mappings WHERE entity = $1 AND header_hash = $2`,
      [job.entity, job.header_hash],
    );
    const saved = rows[0]?.mapping;
    return {
      ...job,
      fields: this.fieldDescriptors(job.entity),
      reused_saved_mapping: Boolean(saved) && JSON.stringify(saved) === JSON.stringify(job.mapping),
    };
  }

  private fieldDescriptors(entity: ImportEntity) {
    return fieldsFor(entity).map((f) => ({
      key: f.key,
      label: f.label,
      hint: f.hint,
      required: Boolean(f.required),
    }));
  }

  private async loadJob(tx: PoolClient, id: string): Promise<JobRow> {
    const { rows } = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS}, source_object_key, header_hash FROM import_jobs WHERE id = $1`, [id]);
    const job = rows[0];
    if (!job) throw ApiException.notFound('import');
    return job;
  }

  private async loadJobForUpdate(tx: PoolClient, id: string): Promise<JobRow> {
    const { rows } = await tx.query<JobRow>(
      `SELECT ${JOB_COLUMNS}, source_object_key, header_hash FROM import_jobs WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const job = rows[0];
    if (!job) throw ApiException.notFound('import');
    return job;
  }
}

interface JobRow {
  id: string;
  entity: ImportEntity;
  store_id: string | null;
  source_object_key: string;
  source_filename: string;
  source_format: string;
  header_hash: string;
  headers: string[];
  mapping: Record<string, string>;
  ai_mapped_fields: string[];
  row_count: number;
  status: string;
  dry_run: unknown;
  error: string | null;
}

/**
 * A dollar amount as typed into a spreadsheet to minor units. Digit by digit,
 * never through a float: `parseFloat("24.99") * 100` is 2498.9999999999995,
 * and a catalog full of prices a cent low is not a rounding curiosity.
 *
 * Accepts the shapes a spreadsheet actually produces -- "$24.99", "24.99",
 * "1,299.00", "(5.00)" for a negative in accounting style -- and rejects
 * anything else rather than guessing.
 */
function majorToMinor(input: string): string | null {
  let text = input.trim().replace(/[$\s,]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return negative ? `-${cents}` : cents;
}

/** A cost or quantity as a plain decimal string. `false` means "present but unreadable", distinct from `null` for absent. */
function readDecimal(input: string | null): string | null | false {
  if (input === null) return null;
  const text = input.replace(/[$\s,]/g, '');
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return false;
  return text;
}

/** E.164, or `false` for something present that can't be one. Matches the dashboard's own rule so a number behaves the same typed or imported. */
function normalizePhone(input: string | null): string | null | false {
  if (input === null) return null;
  const digits = input.replace(/\D/g, '');
  if (input.trim().startsWith('+')) return digits.length >= 8 ? `+${digits}` : false;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return false;
}

/**
 * Month and day out of whatever a sheet calls a birthday. The year is
 * deliberately discarded -- `customers` stores month and day only, because a
 * birthday greeting needs the date and keeping a full date of birth for
 * everyone who ever bought a vape is a liability nobody asked for.
 *
 * US order (month first) for the ambiguous `4/12` case, matching the rest of
 * this app; an ISO `2001-04-12` is recognized by its four-digit lead.
 */
function readBirthday(input: string | null): { month: number; day: number } | null | false {
  if (input === null) return null;
  const parts = input.split(/[\/\-.]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;

  let month: number;
  let day: number;
  if (parts[0]!.length === 4) {
    month = Number(parts[1]);
    day = Number(parts[2] ?? '');
  } else {
    month = Number(parts[0]);
    day = Number(parts[1]);
  }
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return { month, day };
}

function formatMinor(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}$${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Minor units to a plain dollar string with no currency symbol -- an export column a spreadsheet can do arithmetic on and the importer can read back. */
function minorToMajor(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** `numeric(14,6)` arrives as "9.850000"; nobody wants to read four trailing zeros, and the importer parses either form. */
function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/**
 * Whether a SKU can also serve as the item's scannable barcode -- the same
 * rule `barcodeSchema` enforces, checked here so an unsuitable SKU quietly
 * produces an item with no barcode instead of failing the whole row.
 *
 * An internal code like "SHELF 12 / RED" is a perfectly good SKU and is not
 * something a scanner will ever emit.
 */
function isBarcodeShaped(sku: string): boolean {
  return sku.length >= 4 && sku.length <= 48 && /^[0-9A-Za-z._-]+$/.test(sku);
}
