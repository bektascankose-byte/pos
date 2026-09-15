import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { money, type CreateProduct } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogService } from './catalog.service.js';
import { normalizeCode } from './scan-code.js';
import { ApiException } from '../../platform/errors/api-exception.js';

export { normalizeCode };

const REFERENCE_COLUMNS = `id, source, scan_code, item_code, description, department, size,
       retail_minor::text, cost::text, units_per_case, source_quantity::text, created_at`;

export interface ReferenceRowInput {
  scan_code: string;
  item_code?: string | null;
  description?: string | null;
  department?: string | null;
  size?: string | null;
  retail_minor?: string | null;
  cost?: string | null;
  units_per_case?: number | null;
  source_quantity?: string | null;
  raw?: Record<string, unknown>;
}

/**
 * The catalog of things this shop *knows about* rather than sells.
 *
 * See migration 0020 for why this is a separate table rather than inactive
 * products. In short: code that doesn't know about this table cannot
 * accidentally include it, and there are a lot of places that read the
 * catalog.
 */
@Injectable()
export class ReferenceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * What a scanned code is, when the catalog doesn't know.
   *
   * `already_stocked` is answered here too, because the useful question at a
   * scanner is not "is this in the reference file" but "do I already sell
   * this, and if not, what is it".
   */
  async lookup(orgId: string, code: string) {
    const normalized = normalizeCode(code);
    if (!normalized) return { match: null, already_stocked: null };

    return this.db.withOrg(orgId, async (tx) => {
      const existing = await this.catalog.findVariantBySkuOrBarcodeTx(tx, normalized);

      const { rows } = await tx.query(
        `SELECT ${REFERENCE_COLUMNS} FROM reference_products
         WHERE scan_code = $1 ORDER BY created_at DESC LIMIT 1`,
        [normalized],
      );

      return { match: rows[0] ?? null, already_stocked: existing?.id ?? null };
    });
  }

  /**
   * Search, reporting for each row whether the shop already sells it.
   *
   * Answered here rather than left to the caller because this list's entire
   * purpose is deciding what to add, and a row that is already a real product
   * must not offer to be added again -- the attempt would be refused by
   * `promote`, which is a worse way to learn it. The lookup matches SKU and
   * barcode both, the same pair `findVariantBySkuOrBarcodeTx` checks.
   */
  async search(orgId: string, query: string, limit = 50) {
    const q = query.trim();
    if (!q) return [];
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${REFERENCE_COLUMNS},
                (SELECT v.id FROM product_variants v
                 WHERE v.status = 'active'
                   AND (v.sku = r.scan_code
                        OR EXISTS (SELECT 1 FROM variant_barcodes b
                                   WHERE b.variant_id = v.id AND b.barcode = r.scan_code))
                 LIMIT 1) AS stocked_variant_id
         FROM reference_products r
         WHERE scan_code ILIKE '%' || $1 || '%'
            OR lower(description) LIKE '%' || lower($1) || '%'
         ORDER BY description
         LIMIT $2`,
        [q, limit],
      );
      return rows;
    });
  }

  async stats(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT source, count(*)::int AS total,
                count(*) FILTER (WHERE source_quantity > 0)::int AS with_stock,
                max(created_at) AS last_import
         FROM reference_products GROUP BY source ORDER BY source`,
      );
      return rows;
    });
  }

  /**
   * Load or refresh a reference file.
   *
   * Upsert by (source, scan_code) rather than delete-and-reload: re-importing
   * an updated export should correct what changed and leave everything else
   * alone, and a truncate would briefly leave the shop with no lookup at all
   * if the import failed halfway.
   */
  async importRows(orgId: string, actorUserId: string, source: string, rows: ReferenceRowInput[]) {
    return this.db.withOrg(orgId, async (tx) => {
      let written = 0;
      let skipped = 0;

      for (const row of rows) {
        const code = normalizeCode(row.scan_code);
        if (!code) {
          skipped += 1;
          continue;
        }

        await tx.query(
          `INSERT INTO reference_products
             (org_id, source, scan_code, item_code, description, department, size,
              retail_minor, cost, units_per_case, source_quantity, raw)
           VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (org_id, source, scan_code) DO UPDATE SET
             item_code       = EXCLUDED.item_code,
             description     = EXCLUDED.description,
             department      = EXCLUDED.department,
             size            = EXCLUDED.size,
             retail_minor    = EXCLUDED.retail_minor,
             cost            = EXCLUDED.cost,
             units_per_case  = EXCLUDED.units_per_case,
             source_quantity = EXCLUDED.source_quantity,
             raw             = EXCLUDED.raw`,
          [
            source,
            code,
            row.item_code ?? null,
            row.description ?? null,
            row.department ?? null,
            row.size ?? null,
            row.retail_minor ?? null,
            row.cost ?? null,
            row.units_per_case ?? null,
            row.source_quantity ?? null,
            JSON.stringify(row.raw ?? {}),
          ],
        );
        written += 1;
      }

      await this.audit.record(tx, {
        action: 'reference.import',
        entityType: 'reference_products',
        actorUserId,
        newValue: { source, written, skipped },
      });

      return { written, skipped };
    });
  }

  /**
   * Turn a reference row into something the shop actually sells.
   *
   * This is the whole point of keeping the file: the moment a thing is
   * genuinely stocked, everything already known about it becomes a real
   * catalog item without anyone retyping a name off a box. Nothing is
   * received or counted here -- creating the item and having stock of it are
   * separate facts, and stock still only ever comes from the ledger.
   */
  async promote(
    orgId: string,
    actorUserId: string,
    storeId: string | null,
    referenceId: string,
    overrides: { name?: string; category_id?: string; brand_id?: string; price_minor?: string; cost?: string } = {},
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        scan_code: string;
        description: string | null;
        department: string | null;
        retail_minor: string | null;
        cost: string | null;
        units_per_case: number | null;
      }>(
        `SELECT scan_code, description, department, retail_minor::text, cost::text, units_per_case
         FROM reference_products WHERE id = $1`,
        [referenceId],
      );
      const reference = rows[0];
      if (!reference) throw ApiException.notFound('reference item');

      const existing = await this.catalog.findVariantBySkuOrBarcodeTx(tx, reference.scan_code);
      if (existing) {
        throw new ApiException('conflict', 'this item is already in your catalog', { retryable: false });
      }

      const name = overrides.name?.trim() || reference.description?.trim();
      if (!name) {
        throw new ApiException('validation_failed', 'this reference row has no description — give it a name', {
          retryable: false,
        });
      }

      // The department from the old system is matched to a category by name
      // when one exists. Not created: a legacy file's 34 departments are that
      // system's shape, and importing them wholesale would be adopting
      // somebody else's taxonomy by accident.
      let categoryId = overrides.category_id ?? null;
      if (!categoryId && reference.department) {
        const { rows: categoryRows } = await tx.query<{ id: string }>(
          `SELECT id FROM categories WHERE lower(name) = lower($1) AND status = 'active' LIMIT 1`,
          [reference.department],
        );
        categoryId = categoryRows[0]?.id ?? null;
      }

      const priceMinor = overrides.price_minor ?? reference.retail_minor;

      const created = await this.catalog.createProductTx(
        tx,
        actorUserId,
        {
          name,
          unit_type: 'each',
          variant_axes: [],
          tags: [],
          ...(overrides.brand_id ? { brand_id: overrides.brand_id } : {}),
          ...(categoryId ? { category_id: categoryId } : {}),
          variants: [
            {
              sku: reference.scan_code,
              attributes: {},
              barcodes: isBarcodeShaped(reference.scan_code)
                ? [{ barcode: reference.scan_code, is_primary: true }]
                : [],
              cost: overrides.cost ?? reference.cost ?? '0',
              case_quantity: reference.units_per_case && reference.units_per_case > 0 ? reference.units_per_case : 1,
              pack_quantity: 1,
              ...(priceMinor ? { price_minor: money(priceMinor) } : {}),
            },
          ],
        } satisfies CreateProduct,
        storeId,
      );

      await this.audit.record(tx, {
        action: 'reference.promote',
        entityType: 'product',
        entityId: created.id,
        actorUserId,
        newValue: { reference_id: referenceId, scan_code: reference.scan_code, name },
      });

      return { product_id: created.id, variant_id: created.variants[0]!.id, name };
    });
  }
}

function isBarcodeShaped(code: string): boolean {
  return code.length >= 4 && code.length <= 48 && /^[0-9A-Za-z._-]+$/.test(code);
}
