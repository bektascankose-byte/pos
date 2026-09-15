import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { money, type CreateProduct, type CreateProductForScan, type CreateReceivingSession, type UpdateReceivingLine } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ReferenceService } from '../catalog/reference.service.js';
import { InventoryRepository, type Movement } from '../inventory/inventory.repository.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const SESSION_COLUMNS = `s.id, s.store_id, s.vendor_id, v.name AS vendor_name, s.invoice_import_id,
       s.reference, s.note, s.status, s.created_at, s.committed_at,
       (SELECT count(*)::int FROM receiving_lines l WHERE l.session_id = s.id) AS line_count,
       (SELECT count(*)::int FROM receiving_lines l
         WHERE l.session_id = s.id AND l.variant_id IS NULL) AS unresolved_count`;

const LINE_COLUMNS = `l.id, l.variant_id, l.scanned_code, p.name AS product_name, pv.variant_name,
       pv.sku, l.quantity::text, l.unit_cost::text, l.note, l.filled_from_reference, l.created_at`;

const LINE_FROM = `receiving_lines l
       LEFT JOIN product_variants pv ON pv.id = l.variant_id
       LEFT JOIN products p ON p.id = pv.product_id`;

@Injectable()
export class ReceivingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly reference: ReferenceService,
    private readonly inventoryRepository: InventoryRepository,
  ) {}

  async list(orgId: string, storeId?: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${SESSION_COLUMNS}
         FROM receiving_sessions s
         LEFT JOIN vendors v ON v.id = s.vendor_id
         WHERE ($1::uuid IS NULL OR s.store_id = $1)
         ORDER BY s.created_at DESC
         LIMIT 100`,
        [storeId ?? null],
      );
      return rows;
    });
  }

  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, (tx) => this.load(tx, id));
  }

  async create(orgId: string, actorUserId: string, input: CreateReceivingSession) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO receiving_sessions (org_id, store_id, vendor_id, reference, note, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)
         RETURNING id`,
        [input.store_id, input.vendor_id ?? null, input.reference ?? null, input.note ?? null, actorUserId],
      );

      await this.audit.record(tx, {
        action: 'receiving.create',
        entityType: 'receiving_session',
        entityId: rows[0]!.id,
        actorUserId,
        newValue: { reference: input.reference ?? null },
      });

      return this.load(tx, rows[0]!.id);
    });
  }

  /**
   * A whole box in one go: a list of codes, resolved as they land.
   *
   * The same code twice is two of that item, not a duplicate to reject --
   * scanning four identical vapes four times is how you record four of them.
   * They're collapsed into one line with a quantity rather than four lines,
   * because that is what a person expects to see afterwards.
   *
   * A code that resolves to nothing still gets a line. It is almost always a
   * product this shop hasn't stocked before, and refusing the scan would mean
   * losing the count of something physically sitting on the counter.
   */
  async bulkScan(orgId: string, actorUserId: string, id: string, codes: string[]) {
    return this.db.withOrg(orgId, async (tx) => {
      const session = await this.assertOpen(tx, id);

      const tally = new Map<string, number>();
      for (const raw of codes) {
        const code = raw.trim();
        if (!code) continue;
        tally.set(code, (tally.get(code) ?? 0) + 1);
      }

      let filledFromReference = 0;

      for (const [code, count] of tally) {
        // Already on this session? Add to it rather than opening a second
        // line for the same thing -- someone scanning a box in two passes
        // should end with one line of ten, not two lines of five.
        const { rows: existing } = await tx.query<{ id: string }>(
          `SELECT id FROM receiving_lines
           WHERE session_id = $1 AND upper(trim(scanned_code)) = upper(trim($2))
           LIMIT 1`,
          [id, code],
        );

        if (existing[0]) {
          await tx.query(`UPDATE receiving_lines SET quantity = quantity + $2 WHERE id = $1`, [
            existing[0].id,
            count,
          ]);
          continue;
        }

        const resolved = await this.resolveCode(tx, actorUserId, session.store_id, code);
        if (resolved.fromReference) filledFromReference += 1;

        await tx.query(
          `INSERT INTO receiving_lines
             (org_id, session_id, variant_id, scanned_code, quantity, filled_from_reference)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)`,
          [id, resolved.variantId, code, count, resolved.fromReference],
        );
      }

      await this.audit.record(tx, {
        action: 'receiving.scan',
        entityType: 'receiving_session',
        entityId: id,
        actorUserId,
        newValue: { codes: codes.length, distinct: tally.size, filled_from_reference: filledFromReference },
      });

      return this.load(tx, id);
    });
  }

  async addLine(
    orgId: string,
    actorUserId: string,
    id: string,
    input: { scanned_code: string; quantity?: string | undefined; unit_cost?: string | undefined; note?: string | undefined },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const session = await this.assertOpen(tx, id);
      const code = input.scanned_code.trim();

      const { rows: existing } = await tx.query<{ id: string }>(
        `SELECT id FROM receiving_lines
         WHERE session_id = $1 AND upper(trim(scanned_code)) = upper(trim($2)) LIMIT 1`,
        [id, code],
      );

      if (existing[0]) {
        await tx.query(
          `UPDATE receiving_lines SET
             quantity  = quantity + $2::numeric,
             unit_cost = COALESCE($3::numeric, unit_cost),
             note      = COALESCE($4, note)
           WHERE id = $1`,
          [existing[0].id, input.quantity ?? '1', input.unit_cost ?? null, input.note ?? null],
        );
      } else {
        const resolved = await this.resolveCode(tx, actorUserId, session.store_id, code);
        await tx.query(
          `INSERT INTO receiving_lines
             (org_id, session_id, variant_id, scanned_code, quantity, unit_cost, note, filled_from_reference)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            resolved.variantId,
            code,
            input.quantity ?? '1',
            input.unit_cost ?? null,
            input.note ?? null,
            resolved.fromReference,
          ],
        );
      }

      return this.load(tx, id);
    });
  }

  /**
   * What is this code, and if the catalog doesn't know, can the old system's
   * item file answer instead?
   *
   * The catalog is asked first and always wins. Only a code it has never seen
   * goes to `reference_products`, and a hit there creates the product from
   * what that file recorded -- name, price, cost, case size -- so a count can
   * keep moving instead of stopping at a dialog per unfamiliar box.
   *
   * The price it creates with is the price that item had in ANOTHER system on
   * the day that file was exported. That is a real risk and the reason this
   * does not also put stock on the shelf: the session still has to be verified
   * by a person, and the line is flagged so the screen can say which items
   * named themselves. A miss is not an error -- the line stays unresolved,
   * exactly as before, and somebody names it by hand.
   */
  private async resolveCode(
    tx: PoolClient,
    actorUserId: string,
    storeId: string,
    code: string,
  ): Promise<{ variantId: string | null; fromReference: boolean }> {
    const match = await this.catalog.findVariantBySkuOrBarcodeTx(tx, code);
    if (match) return { variantId: match.id, fromReference: false };

    const created = await this.reference.createFromReferenceTx(tx, actorUserId, storeId, code);
    if (!created) return { variantId: null, fromReference: false };
    // Only a product this scan actually *created* carries the warning. One
    // that already existed was simply matched, and needs no second look.
    return { variantId: created.variantId, fromReference: created.created };
  }

  async updateLine(orgId: string, id: string, lineId: string, input: UpdateReceivingLine) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertOpen(tx, id);
      const { rowCount } = await tx.query(
        `UPDATE receiving_lines SET
           variant_id = COALESCE($3, variant_id),
           quantity   = COALESCE($4::numeric, quantity),
           unit_cost  = COALESCE($5::numeric, unit_cost),
           note       = COALESCE($6, note)
         WHERE id = $2 AND session_id = $1`,
        [id, lineId, input.variant_id ?? null, input.quantity ?? null, input.unit_cost ?? null, input.note ?? null],
      );
      if (rowCount === 0) throw ApiException.notFound('receiving line');
      return this.load(tx, id);
    });
  }

  async removeLine(orgId: string, id: string, lineId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertOpen(tx, id);
      await tx.query(`DELETE FROM receiving_lines WHERE id = $2 AND session_id = $1`, [id, lineId]);
      return this.load(tx, id);
    });
  }

  /**
   * Create a product from a scan nothing matched, and point the line at it.
   *
   * The price comes from the chosen price group when no explicit one is
   * given: a group already has a price, and the whole reason to put a new
   * item in one is so it takes that price without anybody typing it. An
   * explicit `price_minor` still wins, because that is someone deciding
   * rather than defaulting.
   */
  async createProductForLine(
    orgId: string,
    actorUserId: string,
    id: string,
    lineId: string,
    input: CreateProductForScan,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertOpen(tx, id);

      const { rows: lineRows } = await tx.query<{ scanned_code: string; variant_id: string | null }>(
        `SELECT scanned_code, variant_id FROM receiving_lines WHERE id = $2 AND session_id = $1`,
        [id, lineId],
      );
      const line = lineRows[0];
      if (!line) throw ApiException.notFound('receiving line');
      if (line.variant_id) {
        throw new ApiException('conflict', 'this line already points at an item', { retryable: false });
      }

      const { rows: storeRows } = await tx.query<{ store_id: string }>(
        `SELECT store_id FROM receiving_sessions WHERE id = $1`,
        [id],
      );
      const storeId = storeRows[0]!.store_id;

      let priceMinor = input.price_minor;
      if (priceMinor === undefined && input.price_group_id) {
        // The price the group's existing members share. `mode()` rather than
        // an average: a group whose members disagree has no single price to
        // inherit, and picking the most common one is the honest answer where
        // one exists.
        const { rows: groupRows } = await tx.query<{ common_price: string | null }>(
          `SELECT mode() WITHIN GROUP (ORDER BY pr.price_minor)::text AS common_price
           FROM product_variants v
           JOIN LATERAL (
             SELECT price_minor FROM variant_prices
             WHERE variant_id = v.id AND kind = 'regular' AND effective_to IS NULL
               AND (store_id = $2 OR store_id IS NULL)
             ORDER BY store_id NULLS LAST LIMIT 1
           ) pr ON true
           WHERE v.price_group_id = $1`,
          [input.price_group_id, storeId],
        );
        const common = groupRows[0]?.common_price;
        if (common) priceMinor = money(common);
      }

      // The scanned code becomes the SKU when none is given -- for this
      // business a SKU and a UPC are the same number, and the code in hand is
      // the one that will be scanned at the till.
      const sku = input.sku?.trim() || line.scanned_code;

      const created = await this.catalog.createProductTx(
        tx,
        actorUserId,
        {
          name: input.name,
          unit_type: 'each',
          variant_axes: [],
          tags: [],
          ...(input.brand_id ? { brand_id: input.brand_id } : {}),
          ...(input.brand_name ? { brand_name: input.brand_name } : {}),
          ...(input.category_id ? { category_id: input.category_id } : {}),
          variants: [
            {
              sku,
              attributes: {},
              barcodes: isBarcodeShaped(line.scanned_code)
                ? [{ barcode: line.scanned_code, is_primary: true }]
                : [],
              cost: input.cost ?? '0',
              case_quantity: 1,
              pack_quantity: 1,
              ...(input.variant_name ? { variant_name: input.variant_name } : {}),
              ...(priceMinor !== undefined ? { price_minor: priceMinor } : {}),
            },
          ],
        } satisfies CreateProduct,
        storeId,
      );

      const variantId = created.variants[0]!.id;

      if (input.price_group_id) {
        await tx.query(`UPDATE product_variants SET price_group_id = $2 WHERE id = $1`, [
          variantId,
          input.price_group_id,
        ]);
      }

      await tx.query(`UPDATE receiving_lines SET variant_id = $2 WHERE id = $1`, [lineId, variantId]);

      return this.load(tx, id);
    });
  }

  /**
   * Put the delivery into stock.
   *
   * Every line posts its own `receiving` movement through the same
   * `InventoryRepository` a purchase order receipt uses -- this never touches
   * `inventory_levels` directly, so the ledger stays the single account of
   * how any level came to be what it is.
   *
   * Refused while any line is still unresolved. A scan nobody has identified
   * is stock of an unknown thing, and guessing would put the count on the
   * wrong item.
   */
  async commit(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const session = await this.assertOpen(tx, id);

      const { rows: lines } = await tx.query<{
        id: string;
        variant_id: string | null;
        quantity: string;
        unit_cost: string | null;
      }>(
        `SELECT id, variant_id, quantity::text, unit_cost::text
         FROM receiving_lines WHERE session_id = $1 ORDER BY created_at`,
        [id],
      );

      if (lines.length === 0) {
        throw new ApiException('validation_failed', 'nothing has been scanned into this delivery yet', {
          retryable: false,
        });
      }

      const unresolved = lines.filter((line) => !line.variant_id).length;
      if (unresolved > 0) {
        throw new ApiException(
          'validation_failed',
          `${unresolved} scanned code${unresolved === 1 ? '' : 's'} still ${unresolved === 1 ? 'needs' : 'need'} to be matched to an item before this can go into stock`,
          { retryable: false },
        );
      }

      const movements: Movement[] = lines.map((line) => ({
        storeId: session.store_id,
        variantId: line.variant_id!,
        delta: line.quantity,
        reason: 'receiving',
        referenceType: 'receiving_session',
        referenceId: id,
        actorUserId,
        ...(line.unit_cost ? { unitCost: line.unit_cost } : {}),
      }));

      await this.inventoryRepository.post(tx, movements);

      await tx.query(
        `UPDATE receiving_sessions SET status = 'committed', committed_at = now() WHERE id = $1`,
        [id],
      );

      await this.audit.record(tx, {
        action: 'receiving.commit',
        entityType: 'receiving_session',
        entityId: id,
        actorUserId,
        newValue: { line_count: lines.length },
      });

      return this.load(tx, id);
    });
  }

  /**
   * Take a verified delivery back out of stock so it can be corrected.
   *
   * The ledger is append-only by design -- "corrections are new rows, never
   * edits" -- so this does NOT delete what verifying posted. It posts the
   * opposite movement against the same session, leaving both halves visible:
   * anyone reading the ledger sees the +6 that went in and the -6 that came
   * back out, which is what actually happened. Deleting the original would
   * make a month-end total that was correct when it was taken silently become
   * a different number.
   *
   * The reason stays `receiving` rather than becoming an adjustment, because
   * this is not a count correction -- it is the undoing of a specific receipt,
   * and the reference columns say which one.
   *
   * Stock is allowed to go negative here, as everywhere else in this ledger: if
   * some of the delivery has already been sold, refusing to unverify would
   * trap the session in a state the shop cannot fix. The count is reported so
   * the caller can say so out loud.
   */
  async unverify(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; store_id: string; status: string }>(
        `SELECT id, store_id, status FROM receiving_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = rows[0];
      if (!session) throw ApiException.notFound('delivery');
      if (session.status !== 'committed') {
        throw new ApiException(
          'conflict',
          session.status === 'open'
            ? 'this delivery has not been verified, so there is nothing to take back out of stock'
            : `this delivery is ${session.status} and cannot be unverified`,
          { retryable: false },
        );
      }

      const { rows: lines } = await tx.query<{
        variant_id: string | null;
        quantity: string;
        unit_cost: string | null;
      }>(
        `SELECT variant_id, quantity::text, unit_cost::text
         FROM receiving_lines WHERE session_id = $1 AND variant_id IS NOT NULL ORDER BY created_at`,
        [id],
      );

      const movements: Movement[] = lines.map((line) => ({
        storeId: session.store_id,
        variantId: line.variant_id!,
        // The negative of what verifying posted. Quantity is numeric(14,3) as
        // a string and is negated as text, never parsed through a float.
        delta: negate(line.quantity),
        reason: 'receiving',
        referenceType: 'receiving_session',
        referenceId: id,
        actorUserId,
        note: 'unverified',
        ...(line.unit_cost ? { unitCost: line.unit_cost } : {}),
      }));

      if (movements.length > 0) await this.inventoryRepository.post(tx, movements);

      // committed_at has to clear with the status: `receiving_committed_at_set`
      // in 0019 requires the two to agree.
      await tx.query(
        `UPDATE receiving_sessions SET status = 'open', committed_at = NULL WHERE id = $1`,
        [id],
      );

      await this.audit.record(tx, {
        action: 'receiving.unverify',
        entityType: 'receiving_session',
        entityId: id,
        actorUserId,
        newValue: { reversed_lines: movements.length },
      });

      return this.load(tx, id);
    });
  }

  async cancel(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertOpen(tx, id);
      await tx.query(`UPDATE receiving_sessions SET status = 'cancelled' WHERE id = $1`, [id]);
      await this.audit.record(tx, {
        action: 'receiving.cancel',
        entityType: 'receiving_session',
        entityId: id,
        actorUserId,
      });
      return this.load(tx, id);
    });
  }

  /**
   * Compare a parsed invoice against what was actually counted.
   *
   * Matching is by SKU, deliberately and only. The invoice has already been
   * through the AI extraction and the matching cascade in `InvoicingService`,
   * which is where fuzzy description matching belongs; by the time a line has
   * a `resolved_variant_id` it names a real item, and comparing real items to
   * real items is arithmetic rather than guesswork. A second, looser matcher
   * here would produce confident-sounding agreement between two things that
   * are not the same product.
   *
   * The output is three lists and a few sentences. The middle list is the
   * point: billed but never scanned, which is either a short shipment or a
   * box still in the van, and worth knowing before the bill is paid.
   */
  async matchInvoice(orgId: string, actorUserId: string, id: string, invoiceImportId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: sessionRows } = await tx.query<{ id: string }>(
        `SELECT id FROM receiving_sessions WHERE id = $1`,
        [id],
      );
      if (!sessionRows[0]) throw ApiException.notFound('delivery');

      const { rows: invoiceRows } = await tx.query<{ id: string }>(
        `SELECT id FROM invoice_imports WHERE id = $1`,
        [invoiceImportId],
      );
      if (!invoiceRows[0]) throw ApiException.notFound('invoice');

      const { rows: received } = await tx.query<{
        variant_id: string | null;
        sku: string | null;
        label: string;
        quantity: string;
      }>(
        `SELECT l.variant_id, pv.sku,
                COALESCE(
                  NULLIF(btrim(COALESCE(p.name, '') || ' ' || COALESCE(pv.variant_name, '')), ''),
                  l.scanned_code
                ) AS label,
                sum(l.quantity)::text AS quantity
         FROM receiving_lines l
         LEFT JOIN product_variants pv ON pv.id = l.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         WHERE l.session_id = $1
         GROUP BY l.variant_id, pv.sku, p.name, pv.variant_name, l.scanned_code`,
        [id],
      );

      const { rows: invoiced } = await tx.query<{
        variant_id: string | null;
        sku: string | null;
        label: string;
        quantity: string | null;
      }>(
        `SELECT il.resolved_variant_id AS variant_id, pv.sku,
                COALESCE(
                  NULLIF(btrim(COALESCE(p.name, '') || ' ' || COALESCE(pv.variant_name, '')), ''),
                  il.parsed_description,
                  il.raw_text
                ) AS label,
                sum(il.parsed_quantity)::text AS quantity
         FROM invoice_import_lines il
         LEFT JOIN product_variants pv ON pv.id = il.resolved_variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         WHERE il.invoice_import_id = $1 AND il.status <> 'ignored'
         GROUP BY il.resolved_variant_id, pv.sku, p.name, pv.variant_name,
                  il.parsed_description, il.raw_text`,
        [invoiceImportId],
      );

      const invoicedByVariant = new Map(
        invoiced.filter((row) => row.variant_id).map((row) => [row.variant_id!, row]),
      );

      const matched: {
        sku: string;
        label: string;
        received_quantity: string;
        invoiced_quantity: string | null;
        difference: string;
      }[] = [];
      const receivedNotInvoiced: { sku: string | null; label: string; received_quantity: string }[] = [];

      for (const row of received) {
        const counterpart = row.variant_id ? invoicedByVariant.get(row.variant_id) : undefined;
        if (!counterpart) {
          receivedNotInvoiced.push({ sku: row.sku, label: row.label, received_quantity: row.quantity });
          continue;
        }
        invoicedByVariant.delete(row.variant_id!);
        const difference = Number(row.quantity) - Number(counterpart.quantity ?? 0);
        matched.push({
          sku: row.sku ?? '',
          label: row.label,
          received_quantity: row.quantity,
          invoiced_quantity: counterpart.quantity,
          difference: String(Math.round(difference * 1000) / 1000),
        });
      }

      // Whatever is still in the map was billed and never scanned -- plus any
      // invoice line the reviewer never resolved to an item at all, which
      // cannot be compared and is reported rather than quietly dropped.
      const invoicedNotReceived = [
        ...[...invoicedByVariant.values()].map((row) => ({
          sku: row.sku,
          label: row.label,
          invoiced_quantity: row.quantity,
        })),
        ...invoiced
          .filter((row) => !row.variant_id)
          .map((row) => ({ sku: null, label: row.label, invoiced_quantity: row.quantity })),
      ];

      const warnings: string[] = [];
      const short = matched.filter((row) => Number(row.difference) < 0);
      const over = matched.filter((row) => Number(row.difference) > 0);
      if (invoicedNotReceived.length > 0) {
        warnings.push(
          `${invoicedNotReceived.length} item${invoicedNotReceived.length === 1 ? ' was' : 's were'} billed but never scanned — either short-shipped, or still in the van.`,
        );
      }
      if (short.length > 0) {
        warnings.push(
          `${short.length} item${short.length === 1 ? '' : 's'} arrived short of what the invoice bills.`,
        );
      }
      if (over.length > 0) {
        warnings.push(
          `${over.length} item${over.length === 1 ? '' : 's'} arrived in greater quantity than billed.`,
        );
      }
      if (receivedNotInvoiced.length > 0) {
        warnings.push(
          `${receivedNotInvoiced.length} scanned item${receivedNotInvoiced.length === 1 ? ' is' : 's are'} not on this invoice at all.`,
        );
      }
      if (warnings.length === 0) {
        warnings.push('Everything on the invoice matches what was counted.');
      }

      await tx.query(`UPDATE receiving_sessions SET invoice_import_id = $2 WHERE id = $1`, [
        id,
        invoiceImportId,
      ]);

      await this.audit.record(tx, {
        action: 'receiving.match_invoice',
        entityType: 'receiving_session',
        entityId: id,
        actorUserId,
        newValue: {
          invoice_import_id: invoiceImportId,
          matched: matched.length,
          invoiced_not_received: invoicedNotReceived.length,
          received_not_invoiced: receivedNotInvoiced.length,
        },
      });

      return {
        invoice_import_id: invoiceImportId,
        matched,
        invoiced_not_received: invoicedNotReceived,
        received_not_invoiced: receivedNotInvoiced,
        warnings,
      };
    });
  }

  private async assertOpen(tx: PoolClient, id: string) {
    const { rows } = await tx.query<{ id: string; store_id: string; status: string }>(
      `SELECT id, store_id, status FROM receiving_sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const session = rows[0];
    if (!session) throw ApiException.notFound('delivery');
    if (session.status !== 'open') {
      throw new ApiException('conflict', `this delivery is already ${session.status}`, {
        retryable: false,
      });
    }
    return session;
  }

  private async load(tx: PoolClient, id: string) {
    const { rows } = await tx.query(
      `SELECT ${SESSION_COLUMNS} FROM receiving_sessions s
       LEFT JOIN vendors v ON v.id = s.vendor_id WHERE s.id = $1`,
      [id],
    );
    const session = rows[0];
    if (!session) throw ApiException.notFound('delivery');

    const { rows: lines } = await tx.query(
      `SELECT ${LINE_COLUMNS} FROM ${LINE_FROM} WHERE l.session_id = $1 ORDER BY l.created_at`,
      [id],
    );
    return { ...session, lines };
  }
}

/** The same rule `barcodeSchema` enforces, checked before offering a scanned code as a barcode. */
function isBarcodeShaped(code: string): boolean {
  return code.length >= 4 && code.length <= 48 && /^[0-9A-Za-z._-]+$/.test(code);
}

/**
 * Flip the sign of a `numeric(14,3)` that is travelling as a string.
 *
 * Textual, not arithmetic: quantities are strings throughout this system
 * precisely so they never pass through a float, and `-Number(q)` would undo
 * that for the one operation where an off-by-a-hair silently unbalances a
 * reversal against the movement it is meant to cancel.
 */
function negate(quantity: string): string {
  const value = quantity.trim();
  return value.startsWith('-') ? value.slice(1) : `-${value}`;
}
