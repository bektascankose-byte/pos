import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CreateBarcode,
  CreateProduct,
  CreateVariant,
  CreateBrand,
  ProductSearch,
  UpdateProduct,
  BulkUpdateProducts,
  UpdateVariant,
  SetVariantPrice,
  BulkPriceVariants,
  SuggestCompliance,
  SuggestVariants,
  RemoveVariantResult,
  AiProductDraft,
  ApplyToAllVariants,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { AiService } from '../../platform/ai/ai.service.js';
import { StockImageService } from './stock-image.service.js';
import { matchUnnamedVariant } from './ai-variant-match.js';

const NO_STORE = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
    private readonly stockImages: StockImageService,
  ) {}

  /**
   * Resolve a scanned barcode to exactly one sellable variant.
   *
   * The hottest path in the system. Everything about it is shaped by a single
   * budget: a scan must reach the cart in under 120ms, and this is the server
   * side equivalent for the dashboard and storefront. One indexed lookup, one
   * join, no search, no fuzzy matching.
   *
   * Note the barcode's `units`: scanning a case of ten adds ten, which is why
   * that number lives on the barcode rather than on the variant.
   */
  async scan(orgId: string, barcode: string, storeId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT v.id            AS variant_id,
                v.sku,
                v.variant_name,
                v.cost::text,
                p.id            AS product_id,
                p.name          AS product_name,
                p.tax_category_id,
                b.units::text   AS scan_units,
                pr.price_minor::text,
                COALESCE(il.on_hand, 0)::text   AS on_hand,
                COALESCE(il.available, 0)::text AS available,
                pc.minimum_age,
                pc.id_scan_required,
                pc.regulated_class
         FROM variant_barcodes b
         JOIN product_variants v ON v.id = b.variant_id
         JOIN products p         ON p.id = v.product_id
         LEFT JOIN product_compliance pc ON pc.product_id = p.id
         LEFT JOIN inventory_levels il
                ON il.variant_id = v.id AND il.store_id = $2
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id
             AND (store_id = $2 OR store_id IS NULL)
             AND kind = 'regular'
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           -- A store specific price wins over the organization default.
           ORDER BY store_id NULLS LAST, effective_from DESC
           LIMIT 1
         ) pr ON true
         WHERE b.barcode = $1
           AND v.status = 'active'
           AND p.status = 'active'
         LIMIT 1`,
        [barcode, storeId],
      );

      const found = rows[0];
      if (!found) throw ApiException.notFound(`barcode ${barcode}`);
      if (found.price_minor === null) {
        // Selling at a price nobody set is how a shop loses money quietly.
        throw new ApiException('conflict', `${found.sku} has no active price at this store`, {
          userMessage: 'This item has no price set. Ask a manager.',
        });
      }
      return found;
    });
  }

  /**
   * Product search.
   *
   * Uses the `variant_search` projection rather than joining six tables on
   * every keystroke. Trigram similarity handles the misspellings that a real
   * counter produces ("geekbar mimi mint"), and falls back to prefix matching
   * where pg_trgm is unavailable.
   */
  async search(orgId: string, params: ProductSearch) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        // Brand and category come back as both id and name: the name is what
        // the list shows, the id is what an edit form has to preselect in a
        // dropdown. Fetching the row twice to get the other half is the
        // alternative. Price groups come back the same way, as a list, since
        // a flavor can be in several (0035).
        `SELECT v.id AS variant_id, v.sku, v.variant_name, v.plu,
                p.id AS product_id, p.name AS product_name,
                p.brand_id, br.name AS brand_name,
                p.category_id, cat.name AS category_name,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY m.added_at, g.id)
                  FROM price_group_members m
                  JOIN price_groups g ON g.id = m.price_group_id
                  WHERE m.variant_id = v.id
                ), '[]'::jsonb) AS price_groups,
                v.cost::text,
                pr.price_minor::text,
                COALESCE(il.on_hand, 0)::text   AS on_hand,
                COALESCE(il.available, 0)::text AS available,
                -- The picture a list row shows: this variant's own if it has
                -- one, otherwise the product's. Flavours that were never
                -- photographed individually still show the product, which is
                -- nearly always the right picture and always better than a gap.
                COALESCE(
                  (SELECT i.id FROM product_images i
                    WHERE i.variant_id = v.id ORDER BY i.sort_order, i.created_at LIMIT 1),
                  (SELECT i.id FROM product_images i
                    WHERE i.product_id = p.id ORDER BY i.sort_order, i.created_at LIMIT 1)
                ) AS image_id
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN brands br ON br.id = p.brand_id
         LEFT JOIN categories cat ON cat.id = p.category_id
         LEFT JOIN inventory_levels il ON il.variant_id = v.id AND il.store_id = $2
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id AND (store_id = $2 OR store_id IS NULL)
             AND kind = 'regular' AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY store_id NULLS LAST, effective_from DESC LIMIT 1
         ) pr ON true
         WHERE v.status = 'active' AND p.status = 'active'
           AND ($1::text IS NULL OR
                p.name ILIKE '%' || $1 || '%' OR
                v.sku  ILIKE '%' || $1 || '%' OR
                v.variant_name ILIKE '%' || $1 || '%' OR
                br.name ILIKE '%' || $1 || '%')
           AND ($3::uuid IS NULL OR p.category_id = $3)
           AND ($4::uuid IS NULL OR p.brand_id = $4)
           AND ($5::boolean IS NOT TRUE OR COALESCE(il.available, 0) > 0)
         ORDER BY p.name, v.sort_order
         LIMIT $6`,
        [
          params.q ?? null,
          params.store_id ?? null,
          params.category_id ?? null,
          params.brand_id ?? null,
          params.in_stock ?? null,
          params.limit,
        ],
      );
      return { data: rows, next_cursor: null };
    });
  }

  /**
   * Create a product with its variants, barcodes and opening price.
   *
   * One transaction. A product that exists with no sellable variant, or a
   * variant with no barcode, is worse than no product at all: it appears in
   * search, fails at the counter, and a cashier has to apologise for it.
   */
  async createProduct(
    orgId: string,
    actorUserId: string,
    input: CreateProduct,
    storeId: string | null,
  ) {
    return this.db.withOrg(orgId, (tx) => this.createProductTx(tx, actorUserId, input, storeId));
  }

  /**
   * The transactional body of `createProduct`, pulled out so invoice-line
   * product creation can create a product and resolve the line to it in one
   * transaction -- the same `xxxTx` split already used for purchase orders
   * and onboarding checklists. `createProduct` above is just this run inside
   * its own `withOrg`, identical behavior, callable in isolation exactly as
   * before this split.
   */
  async createProductTx(
    tx: PoolClient,
    actorUserId: string,
    input: CreateProduct,
    storeId: string | null,
  ) {
    // A brand typed as free text (not yet in the `brands` table) is created
    // here rather than left for the caller to fail on -- `brand_id` still
    // wins when both are given, since a client that already resolved a real
    // id has already done the lookup this exists to avoid repeating.
    const brandId = input.brand_id ?? (input.brand_name ? await this.findOrCreateBrandTx(tx, input.brand_name) : null);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO products
         (org_id, name, short_name, description, brand_id, category_id,
          tax_category_id, unit_type, has_variants, variant_axes, tags, created_by)
       VALUES (current_setting('app.org_id')::uuid,
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.name,
        input.short_name ?? null,
        input.description ?? null,
        brandId,
        input.category_id ?? null,
        input.tax_category_id ?? null,
        input.unit_type,
        input.variants.length > 1,
        input.variant_axes,
        input.tags,
        actorUserId,
      ],
    );

    const productId = rows[0]!.id;

    if (input.compliance) {
      const c = input.compliance;
      await tx.query(
        `INSERT INTO product_compliance
           (org_id, product_id, minimum_age, id_scan_required, regulated_class,
            contains_nicotine, contains_cannabinoid, is_smokable, updated_by)
         VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          productId,
          c.minimum_age ?? null,
          c.id_scan_required ?? false,
          c.regulated_class ?? null,
          c.contains_nicotine ?? false,
          c.contains_cannabinoid ?? false,
          c.is_smokable ?? false,
          actorUserId,
        ],
      );
    }

    const variants = [];
    for (const [index, v] of input.variants.entries()) {
      variants.push(await this.insertVariant(tx, productId, index, v, storeId, actorUserId));
    }

    if (variants.length > 1) await this.sortVariantsTx(tx, productId);

    return { id: productId, variants };
  }

  private async insertVariant(
    tx: PoolClient,
    productId: string,
    index: number,
    v: CreateProduct['variants'][number],
    storeId: string | null,
    actorUserId: string,
  ) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO product_variants
         (org_id, product_id, sku, variant_name, attributes, is_default, sort_order,
          cost, average_cost, case_quantity, pack_quantity, reorder_point, reorder_quantity)
       VALUES (current_setting('app.org_id')::uuid,
               $1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        productId,
        v.sku,
        v.variant_name ?? null,
        JSON.stringify(v.attributes),
        index === 0,
        index,
        v.cost,
        v.case_quantity,
        v.pack_quantity,
        v.reorder_point ?? null,
        v.reorder_quantity ?? null,
      ],
    );
    const variantId = rows[0]!.id;

    for (const [i, b] of v.barcodes.entries()) {
      await tx.query(
        `INSERT INTO variant_barcodes (org_id, variant_id, barcode, kind, units, is_primary)
         VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,$4,$5)`,
        [variantId, b.barcode, b.kind ?? 'upc', b.units ?? '1', b.is_primary ?? i === 0],
      );
    }

    if (v.price_minor !== undefined) {
      await tx.query(
        `INSERT INTO variant_prices
           (org_id, variant_id, store_id, kind, price_minor, created_by)
         VALUES (current_setting('app.org_id')::uuid,$1,$2,'regular',$3,$4)`,
        [variantId, storeId, v.price_minor.toString(), actorUserId],
      );
    }

    return { id: variantId, sku: v.sku };
  }

  /**
   * Put a product's flavors in A to Z order: the order the Variants tab lists
   * them in and, once sent, the order the register shows them under the
   * product's folder, so a flavor is found by its name rather than by when it
   * happened to be added. A flavor with no name yet sorts by its SKU, which
   * puts it with the barcodes, ahead of the names.
   *
   * Only rows whose position actually moves are written, so a product that is
   * already in order produces no change for the Send page to report.
   */
  private async sortVariantsTx(tx: PoolClient, productId: string): Promise<void> {
    await tx.query(
      `UPDATE product_variants v SET sort_order = s.position
       FROM (
         SELECT id,
                (row_number() OVER (
                   ORDER BY lower(COALESCE(NULLIF(trim(variant_name), ''), sku)), id
                 ) - 1)::int AS position
         FROM product_variants
         WHERE product_id = $1
       ) s
       WHERE v.id = s.id AND v.sort_order IS DISTINCT FROM s.position`,
      [productId],
    );
  }

  /**
   * Add one variant to a product that already exists -- another flavor of
   * something already on the shelf, discovered after the product itself was
   * created. Never the product's default variant (`is_default` is decided
   * once, at the product's own creation), and placed in A to Z order among
   * the others -- see `sortVariantsTx`.
   *
   * `has_variants` and `variant_axes` are recomputed from the product's own
   * variants afterward rather than trusted from the caller -- the same
   * invariant `createProductSchema`'s `superRefine` enforces at creation
   * time (several variants need at least one declared axis, or the register
   * has no idea how to group them under one tile), kept true independently
   * here since a 1-to-2-variant transition is exactly when it would
   * otherwise go stale.
   */
  async addVariant(orgId: string, actorUserId: string, productId: string, input: CreateVariant) {
    return this.db.withOrg(orgId, (tx) => this.addVariantTx(tx, actorUserId, productId, input));
  }

  /** The transactional body of `addVariant` -- see `createProductTx`'s own comment for why this split exists. */
  async addVariantTx(tx: PoolClient, actorUserId: string, productId: string, input: CreateVariant) {
    const { rows: productRows } = await tx.query(`SELECT id FROM products WHERE id = $1`, [
      productId,
    ]);
    if (!productRows[0]) throw ApiException.notFound('product');

    const { rows: sortRows } = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM product_variants WHERE product_id = $1`,
      [productId],
    );
    const nextSort = sortRows[0]!.next;

    // `nextSort` is always >= 1 here (the product already has a variant),
    // so this also correctly keeps `is_default` false -- `insertVariant`
    // only sets it true for index 0.
    const variant = await this.insertVariant(tx, productId, nextSort, input, null, actorUserId);
    await this.sortVariantsTx(tx, productId);

    // A flavor added to a product that has a group made for its flavors
    // (`ensureProductPriceGroup`) joins that group, so repricing "Celsius
    // Sparkling 12oz" keeps meaning every Celsius Sparkling 12oz flavor.
    await tx.query(
      `INSERT INTO price_group_members (org_id, price_group_id, variant_id, added_by)
       SELECT g.org_id, g.id, $2, $3 FROM price_groups g WHERE g.product_id = $1
       ON CONFLICT (price_group_id, variant_id) DO NOTHING`,
      [productId, variant.id, actorUserId],
    );

    const { rows: axisRows } = await tx.query<{ axes: string[] }>(
      `SELECT COALESCE(array_agg(DISTINCT key), '{}') AS axes
       FROM product_variants v, jsonb_object_keys(v.attributes) AS key
       WHERE v.product_id = $1`,
      [productId],
    );

    await tx.query(
      `UPDATE products SET has_variants = true, variant_axes = $2 WHERE id = $1`,
      [productId, axisRows[0]!.axes],
    );

    await this.audit.record(tx, {
      action: 'product.variant_add',
      entityType: 'product_variant',
      entityId: variant.id,
      actorUserId,
      newValue: { product_id: productId, sku: input.sku },
    });

    return variant;
  }

  /**
   * An additional, non-primary code for a variant that already has one --
   * the same physical item turning up under a second vendor's own SKU, a
   * relabeled UPC, or the carton it ships in. Never touches the existing
   * primary barcode.
   *
   * `units` is what makes a carton code a carton code: the register multiplies
   * by it (`variant_barcodes.units`, read as `scan_units` by `scan` above), so
   * a case of 10 scanned at the counter rings up ten of the single item rather
   * than one of something else. Defaults keep an ordinary alternate UPC to
   * exactly today's behavior.
   */
  async addBarcodeToVariant(
    orgId: string,
    actorUserId: string,
    variantId: string,
    input: CreateBarcode,
  ) {
    return this.db.withOrg(orgId, (tx) => this.addBarcodeToVariantTx(tx, actorUserId, variantId, input));
  }

  async addBarcodeToVariantTx(
    tx: PoolClient,
    actorUserId: string,
    variantId: string,
    input: CreateBarcode,
  ) {
    const { rows: variantRows } = await tx.query<{ id: string; sku: string; has_primary: boolean }>(
      `SELECT v.id, v.sku,
              EXISTS (SELECT 1 FROM variant_barcodes b
                      WHERE b.variant_id = v.id AND b.is_primary) AS has_primary
       FROM product_variants v WHERE v.id = $1`,
      [variantId],
    );
    const variant = variantRows[0];
    if (!variant) throw ApiException.notFound('variant');

    // A flavor added without a barcode (typed in by hand, or found by the AI
    // fill) gets its first single unit code as its primary: that is the code
    // the register scans, and without a primary the item cannot be sent.
    const units = input.units ?? '1';
    const makePrimary = input.is_primary ?? (!variant.has_primary && Number(units) === 1);
    if (makePrimary && variant.has_primary) {
      await tx.query(`UPDATE variant_barcodes SET is_primary = false WHERE variant_id = $1 AND is_primary`, [
        variantId,
      ]);
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO variant_barcodes (org_id, variant_id, barcode, kind, units, is_primary)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)
       RETURNING id`,
      [variantId, input.barcode, input.kind ?? 'upc', units, makePrimary],
    );

    // A placeholder SKU (TMP-..., given to flavors created before anyone had
    // the package in hand) becomes the barcode itself once there is one, the
    // same convention every imported item already follows. Only while that
    // code is not already some other item's SKU.
    if (makePrimary && variant.sku.startsWith('TMP-')) {
      await tx.query(
        `UPDATE product_variants SET sku = upper($2)
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM product_variants WHERE upper(sku) = upper($2))`,
        [variantId, input.barcode],
      );
    }

    await this.audit.record(tx, {
      action: 'product.barcode_add',
      entityType: 'product_variant',
      entityId: variantId,
      actorUserId,
      newValue: { barcode: input.barcode, kind: input.kind ?? 'upc', units: input.units ?? '1' },
    });

    return rows[0];
  }

  /**
   * Drop a code: an alternate, a carton, or a mistyped primary.
   *
   * A variant is never left without a primary while it still has a single
   * unit code: removing the primary hands the role to the next one. What is
   * refused is removing the last code an item already on the registers scans
   * by: once sent, it would still appear in search and fail at the counter,
   * the state `createProduct` refuses to create in the first place. The fix
   * for a wrong barcode there is add the right one, then remove this.
   */
  async removeBarcodeFromVariant(orgId: string, actorUserId: string, barcodeId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ variant_id: string; barcode: string; is_primary: boolean }>(
        `SELECT variant_id, barcode, is_primary FROM variant_barcodes WHERE id = $1`,
        [barcodeId],
      );
      const existing = rows[0];
      if (!existing) throw ApiException.notFound('barcode');

      let successor: string | null = null;
      if (existing.is_primary) {
        const { rows: others } = await tx.query<{ id: string }>(
          `SELECT id FROM variant_barcodes
           WHERE variant_id = $1 AND id <> $2 AND units = 1
           ORDER BY created_at, barcode
           LIMIT 1`,
          [existing.variant_id, barcodeId],
        );
        successor = others[0]?.id ?? null;
        // A flavor that has never been sent to the registers can lose its
        // only code: nothing scans it yet, and it cannot be sent without one.
        const { rows: onRegisters } = await tx.query(
          `SELECT 1 FROM pos_catalog_variants WHERE variant_id = $1`,
          [existing.variant_id],
        );
        if (!successor && onRegisters[0]) {
          throw new ApiException(
            'validation_failed',
            'That is the only barcode this item scans by. Add the right one first, then remove this one.',
            { retryable: false },
          );
        }
      }

      await tx.query(`DELETE FROM variant_barcodes WHERE id = $1`, [barcodeId]);
      if (successor) {
        await tx.query(`UPDATE variant_barcodes SET is_primary = true WHERE id = $1`, [successor]);
      }

      await this.audit.record(tx, {
        action: 'product.barcode_remove',
        entityType: 'product_variant',
        entityId: existing.variant_id,
        actorUserId,
        oldValue: { barcode: existing.barcode },
      });

      return { id: barcodeId, variant_id: existing.variant_id };
    });
  }

  /**
   * Remove a flavor the shop no longer sells.
   *
   * Deleted outright when nothing refers to it: a flavor added by mistake,
   * or found by the AI fill and never stocked. Otherwise discontinued
   * (archived) instead, because past sales, receipts, stock counts and
   * invoices all name the variant and have to keep naming it. The database
   * decides which: every table holding history references the variant with
   * ON DELETE RESTRICT, so the delete is simply tried and, if refused,
   * turned into an archive.
   *
   * A flavor still on the registers is always discontinued, never deleted:
   * the registers keep selling it until the next Send, and a sale of an item
   * that no longer exists would be refused when it uploads. Either way it
   * comes off the registers with that Send.
   */
  async removeVariant(orgId: string, actorUserId: string, variantId: string): Promise<RemoveVariantResult> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        product_id: string;
        sku: string;
        variant_name: string | null;
        is_default: boolean;
      }>(
        `SELECT id, product_id, sku, variant_name, is_default
         FROM product_variants WHERE id = $1 FOR UPDATE`,
        [variantId],
      );
      const variant = rows[0];
      if (!variant) throw ApiException.notFound('variant');

      const { rows: onRegisters } = await tx.query(
        `SELECT 1 FROM pos_catalog_variants WHERE variant_id = $1`,
        [variantId],
      );
      let reason: string | null = onRegisters[0]
        ? 'It is on the registers, so it stays on record and comes off them with the next Send.'
        : null;

      if (!reason) {
        await tx.query('SAVEPOINT remove_variant');
        try {
          await tx.query(`DELETE FROM product_variants WHERE id = $1`, [variantId]);
          await tx.query('RELEASE SAVEPOINT remove_variant');
        } catch (error) {
          if ((error as { code?: string }).code !== '23503') throw error;
          await tx.query('ROLLBACK TO SAVEPOINT remove_variant');
          reason = 'It has sales, stock or purchase history, so it stays on record as discontinued.';
        }
      }

      if (reason) {
        await tx.query(
          `UPDATE product_variants SET status = 'archived', is_default = false WHERE id = $1`,
          [variantId],
        );
      }

      // The product keeps a default flavor while it has any left on sale:
      // the register opens a multi flavor tile on it.
      if (variant.is_default) {
        await tx.query(
          `UPDATE product_variants SET is_default = true
           WHERE id = (SELECT id FROM product_variants
                       WHERE product_id = $1 AND status = 'active'
                       ORDER BY sort_order, created_at LIMIT 1)`,
          [variant.product_id],
        );
      }

      const { rows: remaining } = await tx.query<{ count: number; axes: string[] }>(
        `SELECT count(*)::int AS count,
                COALESCE((SELECT array_agg(DISTINCT key)
                          FROM product_variants v2, jsonb_object_keys(v2.attributes) AS key
                          WHERE v2.product_id = $1 AND v2.status = 'active'), '{}') AS axes
         FROM product_variants WHERE product_id = $1 AND status = 'active'`,
        [variant.product_id],
      );
      const left = remaining[0]!;
      await tx.query(
        `UPDATE products SET has_variants = $2, variant_axes = CASE WHEN $2 THEN $3 ELSE variant_axes END
         WHERE id = $1`,
        [variant.product_id, left.count > 1, left.axes],
      );

      await this.audit.record(tx, {
        action: reason ? 'product.variant_discontinue' : 'product.variant_delete',
        entityType: 'product_variant',
        entityId: variantId,
        actorUserId,
        oldValue: { product_id: variant.product_id, sku: variant.sku, variant_name: variant.variant_name },
        reason: reason ?? undefined,
      });

      return { outcome: reason ? 'discontinued' : 'deleted', reason };
    });
  }

  /**
   * What this variant has sold for over time, newest first. Free to read:
   * `setVariantPrice` never updates a price row in place, it closes the open
   * one and inserts another, so the table already is the history.
   */
  async priceHistory(orgId: string, variantId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT vp.id, vp.store_id, vp.kind, vp.price_minor::text,
                vp.effective_from, vp.effective_to,
                u.full_name AS changed_by
         FROM variant_prices vp
         LEFT JOIN users u ON u.id = vp.created_by
         WHERE vp.variant_id = $1
         ORDER BY vp.effective_from DESC, vp.id DESC
         LIMIT 50`,
        [variantId],
      );
      return rows;
    });
  }

  /**
   * What item is this code? The back office's own lookup, deliberately not
   * `scan` above: `scan` serves the register, so it refuses an item with no
   * active price ("selling at a price nobody set is how a shop loses money
   * quietly") -- but an unpriced item is exactly what someone looking a code
   * up back here needs to find, in order to go fix it.
   *
   * Reports which code actually matched, so the page can tell a carton code
   * apart from the unit's own: a `units` above 1 is what the register will
   * multiply by when this same code is scanned at the counter.
   */
  async resolveCode(orgId: string, code: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const match = await this.findVariantBySkuOrBarcodeTx(tx, code);
      if (!match) return { match: null };

      const { rows } = await tx.query(
        `SELECT v.id AS variant_id, v.product_id, b.kind AS matched_kind, b.units::text AS matched_units
         FROM product_variants v
         LEFT JOIN variant_barcodes b ON b.variant_id = v.id AND b.barcode = $2
         WHERE v.id = $1
         LIMIT 1`,
        [match.id, code],
      );
      return { match: rows[0] ?? null };
    });
  }

  /**
   * Does a SKU or barcode already resolve to something? For this business
   * the two are the same number (see `docs/ARCHITECTURE.md`'s barcode
   * section) and a manually typed code is checked against both rather than
   * making the user pick which one it is.
   */
  async findVariantBySkuOrBarcodeTx(tx: PoolClient, skuOrBarcode: string): Promise<{ id: string } | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT v.id FROM product_variants v WHERE v.sku = $1 AND v.status = 'active'
       UNION
       SELECT v.id FROM product_variants v
       JOIN variant_barcodes b ON b.variant_id = v.id
       WHERE b.barcode = $1 AND v.status = 'active'
       LIMIT 1`,
      [skuOrBarcode],
    );
    return rows[0] ?? null;
  }

  /**
   * Create a category, deriving its materialized path from its parent.
   *
   * Path and depth are derived here and never accepted from a client. The
   * schema comment assigns this to the application, and a client supplied path
   * that disagrees with parent_id would make the whole tree unnavigable.
   */
  async createCategory(
    orgId: string,
    input: {
      parent_id?: string | null | undefined;
      slug: string;
      name: string;
      sort_order: number;
      is_department: boolean;
    },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      let path = input.slug;
      let depth = 0;

      if (input.parent_id) {
        const { rows } = await tx.query<{ path: string; depth: number }>(
          `SELECT path, depth FROM categories WHERE id = $1`,
          [input.parent_id],
        );
        const parent = rows[0];
        if (!parent) throw ApiException.notFound('parent category');
        path = `${parent.path}.${input.slug}`;
        depth = parent.depth + 1;
      }

      const { rows } = await tx.query(
        `INSERT INTO categories
           (org_id, parent_id, slug, name, path, depth, sort_order, is_department)
         VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,$4,$5,$6,$7)
         RETURNING id, slug, name, path, depth, sort_order, is_department, status`,
        [
          input.parent_id ?? null,
          input.slug,
          input.name,
          path,
          depth,
          input.sort_order,
          input.is_department,
        ],
      );
      return rows[0];
    });
  }

  async listCategories(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, parent_id, slug, name, path, depth, sort_order, tile_color,
                image_url, is_department, status
         FROM categories WHERE status = 'active' ORDER BY path`,
      );
      return rows;
    });
  }

  async listBrands(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, name, brand_family, logo_url, status
         FROM brands WHERE status = 'active' ORDER BY name`,
      );
      return rows;
    });
  }

  async createBrand(orgId: string, input: CreateBrand) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO brands (org_id, name, brand_family, logo_url)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3)
         RETURNING id, name, brand_family, logo_url, status`,
        [input.name, input.brand_family ?? null, input.logo_url ?? null],
      );
      return rows[0];
    });
  }

  /**
   * Used from `createProductTx` and `updateProduct`, for a brand typed as free
   * text rather than picked from the existing list. Case-insensitive: "Sherpa"
   * and "sherpa" are the same brand, not two rows that both mean it.
   */
  private async findOrCreateBrandTx(tx: PoolClient, name: string): Promise<string> {
    const { rows: existing } = await tx.query<{ id: string }>(
      `SELECT id FROM brands WHERE lower(name) = lower($1) LIMIT 1`,
      [name],
    );
    if (existing[0]) return existing[0].id;

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO brands (org_id, name) VALUES (current_setting('app.org_id')::uuid, $1) RETURNING id`,
      [name],
    );
    return rows[0]!.id;
  }

  /**
   * A category named in free text, found or created. Found by name anywhere
   * in the tree first, case-insensitive, so "energy drinks" does not become a
   * second Energy Drinks beside the one the shop already has. Created under
   * `parentId` when given, at the top level otherwise, with a slug made from
   * the name.
   */
  private async findOrCreateCategoryTx(tx: PoolClient, name: string, parentId: string | null): Promise<string> {
    const trimmed = name.trim();
    const { rows: existing } = await tx.query<{ id: string }>(
      `SELECT id FROM categories WHERE lower(name) = lower($1) AND status = 'active'
       ORDER BY (parent_id IS NOT DISTINCT FROM $2::uuid) DESC, depth
       LIMIT 1`,
      [trimmed, parentId],
    );
    if (existing[0]) return existing[0].id;

    const base =
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'category';

    let prefix = '';
    let depth = 0;
    if (parentId) {
      const { rows } = await tx.query<{ path: string; depth: number }>(
        `SELECT path, depth FROM categories WHERE id = $1`,
        [parentId],
      );
      const parent = rows[0];
      if (!parent) throw ApiException.notFound('parent category');
      prefix = `${parent.path}.`;
      depth = parent.depth + 1;
    }

    // A place already held by another category -- one the shop archived, or
    // one whose name has no letters to make a slug from -- is never reused:
    // the new category takes the next free slug instead ("energy-drinks-2"),
    // so nothing archived comes back and nothing unrelated is merged into.
    // ON CONFLICT covers two saves racing for the same slug; the loser tries
    // the next one.
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const slug = attempt === 1 ? base : `${base}-${attempt}`;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO categories (org_id, parent_id, slug, name, path, depth, sort_order, is_department)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5,
                 COALESCE((SELECT max(sort_order) + 1 FROM categories
                           WHERE parent_id IS NOT DISTINCT FROM $1::uuid), 0),
                 false)
         ON CONFLICT (org_id, path) DO NOTHING
         RETURNING id`,
        [parentId, slug, trimmed, `${prefix}${slug}`, depth],
      );
      if (rows[0]) return rows[0].id;
    }
    throw new ApiException('conflict', `could not find a free place for the category "${trimmed}"`, {
      retryable: false,
    });
  }

  /**
   * A suggestion only -- nothing here touches `product_compliance`. The
   * dashboard shows this on the create-product form for a human to review,
   * edit, and submit through the ordinary `createProduct` path.
   */
  async suggestCompliance(input: SuggestCompliance) {
    return this.ai.classifyCompliance(input);
  }

  /**
   * A suggestion only -- nothing here creates a variant. The dashboard shows
   * these as a checklist on the create-product form for a human to pick from.
   */
  async suggestVariants(input: SuggestVariants) {
    return this.ai.suggestProductVariants(input);
  }

  /**
   * Draft this product's whole entry from the web: its name in the shop's
   * format, receipt name, website copy, brand, category, tax category, tags,
   * age restriction and the flavours it is actually sold in.
   *
   * A draft. Nothing here writes anything -- the product page fills its fields
   * with this and the person presses Save, or does not. What this adds on top
   * of `AiService.fillProduct` is turning the names the model answered with
   * into this shop's own ids, which is the part that has to be exact: an
   * unmatched name comes back null and leaves the field for a person, and a
   * flavour the product already has comes back carrying that variant's id so
   * the page can show it as already there rather than offering to add it twice.
   */
  async aiFillProduct(orgId: string, productId: string, hint?: string | undefined): Promise<AiProductDraft> {
    const context = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ name: string; brand_name: string | null }>(
        `SELECT p.name, b.name AS brand_name
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = $1`,
        [productId],
      );
      const product = rows[0];
      if (!product) throw ApiException.notFound('product');

      const [categories, taxCategories, variants] = await Promise.all([
        tx.query<{ id: string; name: string }>(
          `SELECT id, name FROM categories WHERE status = 'active' ORDER BY path`,
        ),
        tx.query<{ id: string; code: string }>(`SELECT id, code FROM tax_categories ORDER BY code`),
        tx.query<{ id: string; variant_name: string | null }>(
          `SELECT id, variant_name FROM product_variants WHERE product_id = $1`,
          [productId],
        ),
      ]);
      return { product, categories: categories.rows, taxCategories: taxCategories.rows, variants: variants.rows };
    });

    const draft = await this.ai.fillProduct({
      product_name: context.product.name,
      brand_name: context.product.brand_name,
      categories: context.categories.map((c) => c.name),
      tax_category_codes: context.taxCategories.map((c) => c.code),
      ...(hint ? { hint } : {}),
    });

    const byLowerName = <T extends { id: string }>(rows: T[], key: (row: T) => string) =>
      new Map(rows.map((row) => [key(row).trim().toLowerCase(), row.id]));
    const categoryIds = byLowerName(context.categories, (c) => c.name);
    const taxIds = byLowerName(context.taxCategories, (c) => c.code);
    const existingVariants = new Map(
      context.variants
        .filter((v): v is { id: string; variant_name: string } => Boolean(v.variant_name))
        .map((v) => [v.variant_name.trim().toLowerCase(), v.id]),
    );

    // The brand, and a proposed new category, are matched but never created
    // here. Creating one would leave a row behind for a draft the person then
    // discarded; saving the draft sends them by name and `updateProduct`
    // finds or creates them then.
    const brandId = draft.brand
      ? await this.db.withOrg(orgId, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `SELECT id FROM brands WHERE lower(name) = lower($1) AND status = 'active' LIMIT 1`,
            [draft.brand],
          );
          return rows[0]?.id ?? null;
        })
      : null;

    // A to Z, the order the Variants tab and the register show flavors in, so
    // the draft reads the same way as what it will become.
    const variants = [...draft.variants]
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }))
      .map((name) => ({
        name,
        existing_variant_id: existingVariants.get(name.trim().toLowerCase()) ?? null,
      }));
    const unnamed = context.variants.filter((v) => !v.variant_name?.trim());
    const current = matchUnnamedVariant(
      context.product.name,
      variants,
      unnamed,
      context.variants.length,
      draft.current_flavor,
    );
    if (current) current.flavor.existing_variant_id = current.variantId;

    return {
      ...draft,
      brand_id: brandId,
      category_id: draft.category ? (categoryIds.get(draft.category.trim().toLowerCase()) ?? null) : null,
      new_category_parent_id: draft.new_category_parent
        ? (categoryIds.get(draft.new_category_parent.trim().toLowerCase()) ?? null)
        : null,
      tax_category_id: draft.tax_category_code
        ? (taxIds.get(draft.tax_category_code.trim().toLowerCase()) ?? null)
        : null,
      variants,
    };
  }

  /**
   * Look for a stock photo of each flavour.
   *
   * Addresses, not photos: what comes back is offered to the person, who keeps
   * the ones that show the right thing. The dashboard is what actually fetches
   * and stores them, because it is already where a product photo gets resized
   * -- see `ImagePanel`.
   */
  async aiFindImages(orgId: string, productId: string, variantNames: string[]) {
    const product = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ name: string; brand_name: string | null }>(
        `SELECT p.name, b.name AS brand_name
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = $1`,
        [productId],
      );
      if (!rows[0]) throw ApiException.notFound('product');
      return rows[0];
    });

    // A few flavors per model call, however many were asked for. One call
    // carrying eighty names runs long and comes back with most of them
    // dropped; the dashboard already batches, and this keeps any other
    // caller from having to know that.
    const BATCH = 15;
    const images: Awaited<ReturnType<AiService['findProductImages']>>['images'] = [];
    for (let start = 0; start < variantNames.length; start += BATCH) {
      const found = await this.ai.findProductImages({
        product_name: product.name,
        brand_name: product.brand_name,
        variants: variantNames.slice(start, start + BATCH),
      });
      // The product's own photo is asked about on every call; keep the first.
      images.push(...found.images.filter((image) => image.variant_name !== null || start === 0));
    }
    return { images: await this.stockImages.resolveAll(images) };
  }

  async listTaxCategories(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, code, name, description FROM tax_categories ORDER BY code`,
      );
      return rows;
    });
  }

  /**
   * One product, every variant, every variant's barcodes and its current
   * price at `storeId` -- store specific beats org default, same precedence
   * `scan`/`search` already use, so a variant priced differently at this
   * store shows that price here and not the org default.
   */
  async getProduct(orgId: string, id: string, storeId: string | null) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: productRows } = await tx.query(
        `SELECT id, name, short_name, description, brand_id, category_id, tax_category_id,
                unit_type, has_variants, variant_axes, image_url, tags, status,
                created_at, updated_at
         FROM products WHERE id = $1`,
        [id],
      );
      const product = productRows[0];
      if (!product) throw ApiException.notFound('product');

      const { rows: complianceRows } = await tx.query(
        `SELECT minimum_age, id_scan_required, regulated_class,
                contains_nicotine, contains_cannabinoid, is_smokable
         FROM product_compliance WHERE product_id = $1`,
        [id],
      );

      const { rows: variantRows } = await tx.query<{ id: string }>(
        `SELECT v.id, v.product_id, v.sku, v.plu, v.variant_name, v.attributes,
                v.is_default, v.sort_order, v.cost::text, v.average_cost::text,
                v.last_cost::text, v.case_quantity, v.pack_quantity,
                v.reorder_point::text, v.reorder_quantity::text, v.status,
                v.case_cost::text, v.case_discount::text, v.case_rebate::text,
                v.default_margin::text,
                pr.price_minor::text
         FROM product_variants v
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id
             AND (store_id = $2 OR store_id IS NULL)
             AND kind = 'regular'
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY store_id NULLS LAST, effective_from DESC
           LIMIT 1
         ) pr ON true
         WHERE v.product_id = $1
         ORDER BY v.sort_order`,
        [id, storeId],
      );

      const variantIds = variantRows.map((v) => v.id);
      const barcodeRows = variantIds.length
        ? (
            await tx.query(
              `SELECT id, variant_id, barcode, kind, units::text, is_primary
               FROM variant_barcodes WHERE variant_id = ANY($1::uuid[])`,
              [variantIds],
            )
          ).rows
        : [];

      const barcodesByVariant = new Map<string, unknown[]>();
      for (const b of barcodeRows as { variant_id: string }[]) {
        const list = barcodesByVariant.get(b.variant_id) ?? [];
        list.push(b);
        barcodesByVariant.set(b.variant_id, list);
      }

      // Read here rather than left to a second request: the page shows them
      // together, and a photo arriving a beat after the name it belongs to is
      // the flicker every product page in the world gets wrong.
      const { rows: imageRows } = await tx.query(
        `SELECT i.id, i.product_id, i.variant_id, i.alt_text, i.source_url, i.sort_order,
                (i.sort_order = (SELECT min(i2.sort_order) FROM product_images i2
                                  WHERE i2.product_id IS NOT DISTINCT FROM i.product_id
                                    AND i2.variant_id IS NOT DISTINCT FROM i.variant_id))
                  AS is_primary,
                i.created_at
         FROM product_images i
         WHERE i.product_id = $1
            OR i.variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)
         ORDER BY i.sort_order, i.created_at`,
        [id],
      );

      return {
        ...product,
        compliance: complianceRows[0] ?? null,
        images: imageRows,
        variants: variantRows.map((v) => ({
          ...v,
          barcodes: barcodesByVariant.get(v.id) ?? [],
        })),
      };
    });
  }

  /**
   * Edit a product's own fields. Never touches its variants -- see
   * `updateVariant` and `setVariantPrice` for those, kept separate the same
   * way the schema keeps price, cost and barcodes off the product row.
   */
  async updateProduct(orgId: string, actorUserId: string, id: string, input: UpdateProduct) {
    return this.db.withOrg(orgId, async (tx) => {
      // A brand typed as a name (the AI draft finds "Celsius" for a shop that
      // has never stocked one) is found or created, the same as at creation.
      // An id still wins when both are given.
      const brandId =
        input.brand_id ?? (input.brand_name ? await this.findOrCreateBrandTx(tx, input.brand_name) : null);
      // Likewise a category by name, which the AI draft proposes when none of
      // the shop's own is a home for the product.
      const categoryId =
        input.category_id ??
        (input.category_name
          ? await this.findOrCreateCategoryTx(tx, input.category_name, input.category_parent_id ?? null)
          : null);

      const { rows } = await tx.query(
        `UPDATE products SET
           name            = COALESCE($2, name),
           short_name      = COALESCE($3, short_name),
           description     = COALESCE($4, description),
           brand_id        = COALESCE($5, brand_id),
           category_id     = COALESCE($6, category_id),
           tax_category_id = COALESCE($7, tax_category_id),
           unit_type       = COALESCE($8, unit_type),
           tags            = COALESCE($9, tags),
           status          = COALESCE($10::entity_status, status)
         WHERE id = $1
         RETURNING id, name, short_name, description, brand_id, category_id, tax_category_id,
                   unit_type, has_variants, variant_axes, image_url, tags, status,
                   created_at, updated_at`,
        [
          id,
          input.name ?? null,
          input.short_name ?? null,
          input.description ?? null,
          brandId,
          categoryId,
          input.tax_category_id ?? null,
          input.unit_type ?? null,
          input.tags ?? null,
          input.status ?? null,
        ],
      );
      const product = rows[0];
      if (!product) throw ApiException.notFound('product');

      // Compliance was accepted by this endpoint's schema but never written:
      // an age restriction set at creation could not be corrected afterwards,
      // which for a shop selling vape and THC is the field that matters most.
      // Upserted rather than inserted -- `product_compliance` is one row per
      // product, and a product created without one still needs to gain it.
      if (input.compliance) {
        const c = input.compliance;
        await tx.query(
          `INSERT INTO product_compliance
             (org_id, product_id, minimum_age, id_scan_required, regulated_class,
              contains_nicotine, contains_cannabinoid, is_smokable, updated_by)
           VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (product_id) DO UPDATE SET
             minimum_age          = EXCLUDED.minimum_age,
             id_scan_required     = EXCLUDED.id_scan_required,
             regulated_class      = EXCLUDED.regulated_class,
             contains_nicotine    = EXCLUDED.contains_nicotine,
             contains_cannabinoid = EXCLUDED.contains_cannabinoid,
             is_smokable          = EXCLUDED.is_smokable,
             updated_by           = EXCLUDED.updated_by`,
          [
            id,
            c.minimum_age ?? null,
            c.id_scan_required ?? false,
            c.regulated_class ?? null,
            c.contains_nicotine ?? false,
            c.contains_cannabinoid ?? false,
            c.is_smokable ?? false,
            actorUserId,
          ],
        );
      }

      await this.audit.record(tx, {
        action: 'product.update',
        entityType: 'product',
        entityId: id,
        actorUserId,
        newValue: input,
      });

      return product;
    });
  }

  /** The same field set as `updateProduct`, applied to every product_id at once, in one transaction. */
  async bulkUpdateProducts(orgId: string, actorUserId: string, input: BulkUpdateProducts) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE products SET
           category_id     = COALESCE($2, category_id),
           brand_id        = COALESCE($3, brand_id),
           tax_category_id = COALESCE($4, tax_category_id),
           status          = COALESCE($5, status)
         WHERE id = ANY($1::uuid[])
         RETURNING id`,
        [
          input.product_ids,
          input.category_id ?? null,
          input.brand_id ?? null,
          input.tax_category_id ?? null,
          input.status ?? null,
        ],
      );

      await this.audit.record(tx, {
        action: 'product.bulk_update',
        entityType: 'product',
        actorUserId,
        newValue: input,
      });

      return { updated: rows.map((r) => r.id) };
    });
  }

  /**
   * Edit a variant's own fields -- never its price; see `setVariantPrice`.
   *
   * `cost` is derived rather than accepted whenever this variant has a case
   * cost to derive it from: a unit cost that disagrees with the case it came
   * out of is the bug this arrangement exists to prevent. Every reference
   * below reads the row's existing value (an UPDATE's right-hand side sees the
   * old row), so changing only the case quantity re-divides the case cost that
   * was already on file.
   */
  async updateVariant(orgId: string, actorUserId: string, id: string, input: UpdateVariant) {
    return this.db.withOrg(orgId, (tx) => this.updateVariantTx(tx, actorUserId, id, input));
  }

  /**
   * Apply the same case costs, default margin and price to every flavor of a
   * product at once, in one transaction: the "All flavors" choice on the Cost
   * & Margin tab. Each flavor goes through exactly what editing it alone does
   * (`updateVariantTx`, `closeAndOpenPrice`), so its cost is derived from the
   * case the same way and its price keeps its own history.
   *
   * Every flavor that is not archived. A discontinued flavor keeps what it
   * had: it is not being sold, and its figures are history.
   */
  async applyToAllVariants(
    orgId: string,
    actorUserId: string,
    productId: string,
    input: ApplyToAllVariants,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: variantRows } = await tx.query<{ id: string }>(
        `SELECT id FROM product_variants
         WHERE product_id = $1 AND status <> 'archived'
         ORDER BY sort_order`,
        [productId],
      );
      if (variantRows.length === 0) throw ApiException.notFound('product');

      const { price_minor: priceMinor, store_id: storeId, ...fields } = input;
      const hasFields = Object.values(fields).some((value) => value !== undefined);

      const variants = [];
      for (const { id } of variantRows) {
        if (hasFields) variants.push(await this.updateVariantTx(tx, actorUserId, id, fields));
        if (priceMinor !== undefined) {
          await this.closeAndOpenPrice(tx, actorUserId, id, storeId ?? null, priceMinor.toString());
        }
      }
      return { updated: variantRows.length, variants };
    });
  }

  private async updateVariantTx(tx: PoolClient, actorUserId: string, id: string, input: UpdateVariant) {
    const { rows } = await tx.query(
      `UPDATE product_variants SET
         variant_name     = COALESCE($2, variant_name),
         plu              = COALESCE($13, plu),
         cost             = CASE
                              WHEN COALESCE($9, case_cost) IS NOT NULL
                                THEN (COALESCE($9, case_cost) - COALESCE($10, case_discount))
                                     / GREATEST(COALESCE($4, case_quantity), 1)
                              ELSE COALESCE($3, cost)
                            END,
         case_quantity    = COALESCE($4, case_quantity),
         pack_quantity    = COALESCE($5, pack_quantity),
         reorder_point    = COALESCE($6, reorder_point),
         reorder_quantity = COALESCE($7, reorder_quantity),
         status           = COALESCE($8, status),
         case_cost        = COALESCE($9, case_cost),
         case_discount    = COALESCE($10, case_discount),
         case_rebate      = COALESCE($11, case_rebate),
         default_margin   = COALESCE($12, default_margin)
       WHERE id = $1
       RETURNING id, product_id, sku, plu, variant_name, attributes, is_default, sort_order,
                 cost::text, average_cost::text, last_cost::text, case_quantity, pack_quantity,
                 reorder_point::text, reorder_quantity::text, status,
                 case_cost::text, case_discount::text, case_rebate::text, default_margin::text`,
      [
        id,
        input.variant_name ?? null,
        input.cost ?? null,
        input.case_quantity ?? null,
        input.pack_quantity ?? null,
        input.reorder_point ?? null,
        input.reorder_quantity ?? null,
        input.status ?? null,
        input.case_cost ?? null,
        input.case_discount ?? null,
        input.case_rebate ?? null,
        input.default_margin ?? null,
        input.plu ?? null,
      ],
    );
    const variant = rows[0];
    if (!variant) throw ApiException.notFound('variant');

    await this.audit.record(tx, {
      action: 'variant.update',
      entityType: 'product_variant',
      entityId: id,
      actorUserId,
      newValue: input,
    });

    if (input.variant_name !== undefined) await this.sortVariantsTx(tx, variant.product_id as string);

    return variant;
  }

  /**
   * Change what a variant sells for.
   *
   * Never a plain UPDATE. `variant_prices_open_regular_key` allows at most one
   * open-ended regular price per (variant, store scope), which models price
   * as a history: closing the row that was open and inserting a new one is
   * how a price change is recorded here, the same way a sale is never edited
   * in place elsewhere in this schema. Closing before inserting, in that
   * order, is what keeps the unique index from ever seeing two open rows at
   * once.
   */
  async setVariantPrice(
    orgId: string,
    actorUserId: string,
    variantId: string,
    input: SetVariantPrice,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: variantRows } = await tx.query(
        `SELECT id FROM product_variants WHERE id = $1`,
        [variantId],
      );
      if (!variantRows[0]) throw ApiException.notFound('variant');

      return this.closeAndOpenPrice(tx, actorUserId, variantId, input.store_id ?? null, input.price_minor.toString());
    });
  }

  /**
   * Price several variants together, in one transaction.
   *
   * `price_group_id` reprices every flavor in that group, with no need to
   * re-select them. `variant_ids` prices exactly that selection and keeps it
   * as a group so it can be repriced the same way later -- reusing a group
   * that already holds exactly this selection, named ones first, rather than
   * minting another each time. "Reprice this same set again" should not leave
   * debris behind.
   *
   * A flavor can sit in several groups (0035), so this never takes anything
   * out of a group. Pricing one group moves only its own members, and a
   * member's price is whatever was set last, here or anywhere else: a group
   * has no price of its own to disagree with. Discontinued flavors stay
   * members but are skipped -- nobody can sell them, and a new row in each
   * one's price history would only be noise.
   */
  async bulkSetPrice(orgId: string, actorUserId: string, input: BulkPriceVariants) {
    return this.db.withOrg(orgId, async (tx) => {
      let variantIds: string[];
      let priceGroupId: string;

      if (input.price_group_id) {
        priceGroupId = input.price_group_id;
        const { rows: groupRows } = await tx.query(`SELECT id FROM price_groups WHERE id = $1`, [priceGroupId]);
        if (!groupRows[0]) throw ApiException.notFound('price group');

        const { rows } = await tx.query<{ id: string }>(
          `SELECT v.id FROM price_group_members m
           JOIN product_variants v ON v.id = m.variant_id
           WHERE m.price_group_id = $1 AND v.status <> 'archived'
           ORDER BY v.id`,
          [priceGroupId],
        );
        variantIds = rows.map((r) => r.id);
        if (variantIds.length === 0) {
          throw new ApiException('conflict', 'this price group has no items on sale', {
            userMessage: 'Add items to this group before pricing it.',
          });
        }
      } else {
        variantIds = [...new Set(input.variant_ids!)];

        const { rows: currentRows } = await tx.query<{ id: string }>(
          `SELECT id FROM product_variants WHERE id = ANY($1::uuid[])`,
          [variantIds],
        );
        if (currentRows.length !== variantIds.length) throw ApiException.notFound('variant');

        const { rows: sameSet } = await tx.query<{ id: string }>(
          `SELECT g.id
           FROM price_groups g
           JOIN price_group_members m ON m.price_group_id = g.id
           GROUP BY g.id, g.name, g.created_at
           HAVING count(*) = $2 AND bool_and(m.variant_id = ANY($1::uuid[]))
           ORDER BY (g.name IS NULL), g.created_at
           LIMIT 1`,
          [variantIds, variantIds.length],
        );

        if (sameSet[0]) {
          priceGroupId = sameSet[0].id;
        } else {
          const { rows: groupRows } = await tx.query<{ id: string }>(
            `INSERT INTO price_groups (org_id, created_by)
             VALUES (current_setting('app.org_id')::uuid, $1)
             RETURNING id`,
            [actorUserId],
          );
          priceGroupId = groupRows[0]!.id;
          await this.addMembersTx(tx, actorUserId, priceGroupId, variantIds);
        }
      }

      const storeId = input.store_id ?? null;
      const prices = [];
      for (const variantId of variantIds) {
        prices.push(await this.closeAndOpenPrice(tx, actorUserId, variantId, storeId, input.price_minor.toString()));
      }

      return { price_group_id: priceGroupId, prices };
    });
  }

  /**
   * Put flavors into a group, leaving whatever other groups they are in
   * alone. One that is already a member is not an error -- "is it in the
   * group" is yes either way -- so what comes back is only the ones that
   * joined just now. Callers check the variants exist first; a missing one
   * would fail the foreign key rather than be skipped.
   */
  private async addMembersTx(tx: PoolClient, actorUserId: string, groupId: string, variantIds: string[]) {
    if (variantIds.length === 0) return [];
    const { rows } = await tx.query<{ variant_id: string }>(
      `INSERT INTO price_group_members (org_id, price_group_id, variant_id, added_by)
       SELECT current_setting('app.org_id')::uuid, $1, t.id, $3
       FROM unnest($2::uuid[]) AS t(id)
       ON CONFLICT (price_group_id, variant_id) DO NOTHING
       RETURNING variant_id`,
      [groupId, variantIds, actorUserId],
    );
    return rows.map((r) => r.variant_id);
  }

  /**
   * The group made for one product's flavors: found, or made now.
   *
   * Saving an AI draft calls this once the draft has found the whole line, so
   * "Celsius Sparkling 12oz" turns up on the price groups page holding every
   * Celsius Sparkling 12oz flavor, ready to reprice all at once later. No
   * price changes here: flavors priced differently stay priced differently.
   *
   * Made once per product. Drafting the item again finds the same group and
   * leaves its membership as it is, so a flavor someone deliberately took out
   * (say, into a clearance promotion) is not quietly put back. New flavors
   * join it as they are added (`addVariantTx`). A group of one flavor is not
   * worth having, so a single flavor item gets none.
   *
   * A group somebody already built by hand holding exactly this product's
   * flavors and nothing else is adopted rather than duplicated -- the shop
   * that grouped its 48 Foger pods before this existed should not find a
   * second group of the same 48 after drafting them.
   */
  async ensureProductPriceGroup(orgId: string, actorUserId: string, productId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: productRows } = await tx.query<{ name: string }>(
        `SELECT name FROM products WHERE id = $1`,
        [productId],
      );
      const product = productRows[0];
      if (!product) throw ApiException.notFound('product');

      const found = await tx.query<{ id: string; name: string | null }>(
        `SELECT id, name FROM price_groups WHERE product_id = $1`,
        [productId],
      );
      if (found.rows[0]) {
        return { price_group: found.rows[0], created: false, added: 0 };
      }

      const { rows: variantRows } = await tx.query<{ id: string }>(
        `SELECT id FROM product_variants
         WHERE product_id = $1 AND status <> 'archived'
         ORDER BY sort_order, id`,
        [productId],
      );
      if (variantRows.length < 2) return { price_group: null, created: false, added: 0 };

      const { rows: adoptable } = await tx.query<{ id: string; name: string | null }>(
        `SELECT g.id, g.name
         FROM price_groups g
         WHERE g.product_id IS NULL
           AND EXISTS (SELECT 1 FROM price_group_members m WHERE m.price_group_id = g.id)
           AND NOT EXISTS (
             SELECT 1 FROM price_group_members m
             JOIN product_variants v ON v.id = m.variant_id
             WHERE m.price_group_id = g.id AND v.product_id <> $1)
           AND NOT EXISTS (
             SELECT 1 FROM product_variants v
             WHERE v.product_id = $1 AND v.status <> 'archived'
               AND NOT EXISTS (SELECT 1 FROM price_group_members m
                               WHERE m.price_group_id = g.id AND m.variant_id = v.id))
         ORDER BY (g.name IS NULL), g.created_at
         LIMIT 1`,
        [productId],
      );

      const name = product.name.slice(0, 128);
      let group: { id: string; name: string | null };
      let created = false;
      if (adoptable[0]) {
        const { rows } = await tx.query<{ id: string; name: string | null }>(
          `UPDATE price_groups SET product_id = $2, name = COALESCE(name, $3)
           WHERE id = $1 RETURNING id, name`,
          [adoptable[0].id, productId, name],
        );
        group = rows[0]!;
      } else {
        const { rows } = await tx.query<{ id: string; name: string | null }>(
          `INSERT INTO price_groups (org_id, name, product_id, created_by)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3)
           RETURNING id, name`,
          [name, productId, actorUserId],
        );
        group = rows[0]!;
        created = true;
      }

      const added = await this.addMembersTx(tx, actorUserId, group.id, variantRows.map((r) => r.id));

      await this.audit.record(tx, {
        action: created ? 'product.price_group_create' : 'product.price_group_adopt',
        entityType: 'price_group',
        entityId: group.id,
        actorUserId,
        newValue: { product_id: productId, name: group.name, variant_ids: added },
      });

      return { price_group: group, created, added: added.length };
    });
  }

  /**
   * A named `price_groups` row, declared ahead of its first member -- unlike
   * `bulkSetPrice`, which only ever forms a group incidentally while pricing
   * one. Building a category's membership and setting its price are two
   * separate, deliberate actions from here on.
   */
  async createPriceCategory(orgId: string, actorUserId: string, name: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO price_groups (org_id, name, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2)
         RETURNING id`,
        [name, actorUserId],
      );
      return { id: rows[0]!.id };
    });
  }

  async renamePriceCategory(orgId: string, actorUserId: string, id: string, name: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; name: string }>(
        `UPDATE price_groups SET name = $2 WHERE id = $1 RETURNING id, name`,
        [id, name],
      );
      const group = rows[0];
      if (!group) throw ApiException.notFound('price group');

      await this.audit.record(tx, {
        action: 'product.price_group_rename',
        entityType: 'price_group',
        entityId: id,
        actorUserId,
        newValue: { name },
      });

      return group;
    });
  }

  /**
   * Dissolve a price group.
   *
   * Releases its members and destroys nothing else -- the items, their prices
   * and their price history are untouched, and so is every other group those
   * items are in. A group is a saved grouping, not something anyone sells, so
   * deleting one is the cheap, reversible act of ungrouping rather than the
   * expensive one of removing products. That distinction is the whole reason
   * this is a real DELETE while a product can only ever be archived.
   *
   * The memberships go with the group through the cascade; they are counted
   * first so the confirmation can say how many items came out.
   */
  async deletePriceCategory(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: existing } = await tx.query<{ members: number }>(
        `SELECT (SELECT count(*)::int FROM price_group_members m WHERE m.price_group_id = g.id) AS members
         FROM price_groups g WHERE g.id = $1`,
        [id],
      );
      if (!existing[0]) throw ApiException.notFound('price group');
      const released = existing[0].members;

      await tx.query(`DELETE FROM price_groups WHERE id = $1`, [id]);

      await this.audit.record(tx, {
        action: 'product.price_group_delete',
        entityType: 'price_group',
        entityId: id,
        actorUserId,
        newValue: { released },
      });

      return { deleted: true, released };
    });
  }

  async listPriceCategories(orgId: string, storeId: string | null) {
    return this.db.withOrg(orgId, async (tx) => {
      // `mismatch_count` is the point of grouping prices in the first place:
      // how many members have drifted off the price the rest of the group
      // shares. The group's own price is taken as the most common one among
      // its members (`mode()`, returned as `common_price_minor`), and a member
      // with no price at all counts as mismatched -- it's exactly as wrong at
      // the counter as one priced differently. A flavor that is also in a
      // promotion shows up here as off the price, which is the truth: repricing
      // this group would take it off the promotion price.
      //
      // Discontinued flavors are left out of every figure: they stay members,
      // but nobody can sell them and repricing the group skips them.
      const { rows } = await tx.query(
        `WITH member_prices AS (
           SELECT g.id AS group_id, g.name, g.created_at, g.product_id,
                  v.id AS variant_id, pr.price_minor
           FROM price_groups g
           LEFT JOIN (price_group_members m
                      JOIN product_variants v ON v.id = m.variant_id AND v.status <> 'archived')
             ON m.price_group_id = g.id
           LEFT JOIN LATERAL (
             SELECT price_minor FROM variant_prices
             WHERE variant_id = v.id
               AND (store_id = $2 OR store_id IS NULL)
               AND kind = 'regular'
               AND effective_from <= now()
               AND (effective_to IS NULL OR effective_to > now())
             ORDER BY store_id NULLS LAST, effective_from DESC
             LIMIT 1
           ) pr ON true
           WHERE g.org_id = $1
         ),
         group_mode AS (
           SELECT group_id, mode() WITHIN GROUP (ORDER BY price_minor) AS common_price
           FROM member_prices
           WHERE price_minor IS NOT NULL
           GROUP BY group_id
         ),
         -- How many prices tie for most common. On a tie mode() still picks
         -- one, and the mismatch count comes out the same whichever it picks,
         -- but calling that price "the group's" would be a coin toss: two at
         -- $2.99 and two at $1.99 is mixed, not mostly anything.
         top_prices AS (
           SELECT group_id, count(*) FILTER (WHERE place = 1) AS tied
           FROM (
             SELECT group_id, rank() OVER (PARTITION BY group_id ORDER BY count(*) DESC) AS place
             FROM member_prices
             WHERE price_minor IS NOT NULL
             GROUP BY group_id, price_minor
           ) ranked
           GROUP BY group_id
         )
         SELECT mp.group_id AS id, mp.name, mp.created_at, mp.product_id,
                count(mp.variant_id)::int AS member_count,
                (CASE WHEN count(mp.variant_id) > 0
                           AND count(mp.price_minor) = count(mp.variant_id)
                           AND count(DISTINCT mp.price_minor) = 1
                      THEN min(mp.price_minor) ELSE NULL END)::text
                  AS current_price_minor,
                (CASE WHEN tp.tied = 1 THEN gm.common_price END)::text AS common_price_minor,
                count(mp.variant_id) FILTER (
                  WHERE mp.price_minor IS DISTINCT FROM gm.common_price
                )::int AS mismatch_count
         FROM member_prices mp
         LEFT JOIN group_mode gm ON gm.group_id = mp.group_id
         LEFT JOIN top_prices tp ON tp.group_id = mp.group_id
         GROUP BY mp.group_id, mp.name, mp.created_at, mp.product_id, gm.common_price, tp.tied
         ORDER BY mp.created_at DESC`,
        [orgId, storeId],
      );
      return rows;
    });
  }

  async getPriceCategory(orgId: string, id: string, storeId: string | null) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: categoryRows } = await tx.query(
        `SELECT g.id, g.name, g.created_at, g.product_id
         FROM price_groups g
         WHERE g.id = $1 AND g.org_id = $2`,
        [id, orgId],
      );
      const category = categoryRows[0];
      if (!category) throw ApiException.notFound('price category');

      // `also_in` is the other groups a member sits in, and `price_since` when
      // its current price was set: between them they answer "why is this one
      // $1.99 when the rest are $2.99" -- it was priced last through the
      // promotion it is also in.
      const { rows: members } = await tx.query<{
        variant_id: string;
        price_minor: string | null;
      }>(
        `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name,
                v.variant_name, v.sku, pr.price_minor::text AS price_minor,
                pr.effective_from AS price_since,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('id', g2.id, 'name', g2.name) ORDER BY g2.created_at)
                  FROM price_group_members m2
                  JOIN price_groups g2 ON g2.id = m2.price_group_id
                  WHERE m2.variant_id = v.id AND m2.price_group_id <> $1
                ), '[]'::jsonb) AS also_in
         FROM price_group_members m
         JOIN product_variants v ON v.id = m.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN LATERAL (
           SELECT price_minor, effective_from FROM variant_prices
           WHERE variant_id = v.id
             AND (store_id = $2 OR store_id IS NULL)
             AND kind = 'regular'
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY store_id NULLS LAST, effective_from DESC
           LIMIT 1
         ) pr ON true
         WHERE m.price_group_id = $1 AND v.status <> 'archived'
         ORDER BY lower(p.name), lower(COALESCE(v.variant_name, '')), v.sku`,
        [id, storeId],
      );

      const priced = members.map((m) => m.price_minor);
      const uniform = priced.length > 0 && priced.every((p) => p !== null && p === priced[0]);
      return {
        ...category,
        member_count: members.length,
        current_price_minor: uniform ? priced[0] : null,
        members,
      };
    });
  }

  /**
   * Add flavors to a group without touching their price -- building a
   * group's membership is separate from setting its price (`bulkSetPrice`
   * does that). A flavor can be in any number of groups, so this never takes
   * one out of another group.
   */
  async addVariantsToPriceCategory(
    orgId: string,
    actorUserId: string,
    categoryId: string,
    variantIds: string[],
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: categoryRows } = await tx.query(`SELECT id FROM price_groups WHERE id = $1`, [categoryId]);
      if (!categoryRows[0]) throw ApiException.notFound('price category');

      const wanted = [...new Set(variantIds)];
      const { rows: variantRows } = await tx.query<{ id: string }>(
        `SELECT id FROM product_variants WHERE id = ANY($1::uuid[])`,
        [wanted],
      );
      if (variantRows.length !== wanted.length) throw ApiException.notFound('variant');

      const added = await this.addMembersTx(tx, actorUserId, categoryId, wanted);

      if (added.length > 0) {
        await this.audit.record(tx, {
          action: 'product.price_category_add_member',
          entityType: 'price_group',
          entityId: categoryId,
          actorUserId,
          newValue: { variant_ids: added },
        });
      }

      return { price_group_id: categoryId, added: added.length, already: wanted.length - added.length };
    });
  }

  /** Take one flavor out of one group. Its price, and any other group it is in, stay as they are. */
  async removeVariantFromPriceCategory(orgId: string, actorUserId: string, categoryId: string, variantId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ variant_id: string }>(
        `DELETE FROM price_group_members
         WHERE price_group_id = $1 AND variant_id = $2
         RETURNING variant_id`,
        [categoryId, variantId],
      );
      if (!rows[0]) throw ApiException.notFound('price category member');

      await this.audit.record(tx, {
        action: 'product.price_category_remove_member',
        entityType: 'price_group',
        entityId: categoryId,
        actorUserId,
        newValue: { variant_id: variantId },
      });

      return { removed: variantId };
    });
  }

  /**
   * The speed-scan path: one typed/scanned SKU or barcode at a time, resolved
   * the same way a manually typed SKU is during invoice review
   * (`findVariantBySkuOrBarcodeTx`), then added to the category exactly like
   * `addVariantsToPriceCategory` -- just returning enough about the match,
   * price included, for the caller to show it in the list straight away.
   */
  async scanAddToPriceCategory(
    orgId: string,
    actorUserId: string,
    categoryId: string,
    code: string,
    storeId: string | null,
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: categoryRows } = await tx.query(`SELECT id FROM price_groups WHERE id = $1`, [categoryId]);
      if (!categoryRows[0]) throw ApiException.notFound('price category');

      const match = await this.findVariantBySkuOrBarcodeTx(tx, code);
      if (!match) throw ApiException.notFound(`item for code "${code}"`);

      const added = await this.addMembersTx(tx, actorUserId, categoryId, [match.id]);

      const { rows } = await tx.query<{
        product_id: string;
        product_name: string;
        variant_name: string | null;
        sku: string;
        price_minor: string | null;
      }>(
        `SELECT p.id AS product_id, p.name AS product_name, v.variant_name, v.sku,
                pr.price_minor::text AS price_minor
         FROM product_variants v JOIN products p ON p.id = v.product_id
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id
             AND (store_id = $2 OR store_id IS NULL)
             AND kind = 'regular'
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY store_id NULLS LAST, effective_from DESC
           LIMIT 1
         ) pr ON true
         WHERE v.id = $1`,
        [match.id, storeId],
      );

      if (added.length > 0) {
        await this.audit.record(tx, {
          action: 'product.price_category_add_member',
          entityType: 'price_group',
          entityId: categoryId,
          actorUserId,
          newValue: { variant_id: match.id, via: 'scan' },
        });
      }

      return { variant_id: match.id, ...rows[0]!, already_member: added.length === 0 };
    });
  }

  /**
   * Close whatever regular price was open for a variant at a store scope and
   * open a new one -- the one place this happens, shared by a single price
   * change and a bulk one. Never a plain UPDATE:
   * `variant_prices_open_regular_key` allows at most one open-ended regular
   * price per (variant, store scope), which models price as a history, the
   * same way a sale is never edited in place elsewhere in this schema.
   * Closing before inserting, in that order, is what keeps the unique index
   * from ever seeing two open rows at once.
   */
  /**
   * A price change, effective-dated: close the open row and insert a new one,
   * so `variant_prices` *is* the history rather than needing one kept
   * alongside it. Never an UPDATE of `price_minor` in place -- that would
   * destroy what the item used to cost, which is the one question a margin
   * report and a pricing dispute both start from.
   *
   * Public (and transactional) so the spreadsheet importer changes a price
   * the same way the item page does, inside its own single transaction. A
   * second implementation of this rule is how a bulk path quietly stops
   * recording history.
   */
  async closeAndOpenPrice(
    tx: PoolClient,
    actorUserId: string,
    variantId: string,
    storeId: string | null,
    priceMinor: string,
  ) {
    await tx.query(
      `UPDATE variant_prices SET effective_to = now()
       WHERE variant_id = $1 AND kind = 'regular' AND effective_to IS NULL
         AND COALESCE(store_id, $3::uuid) = COALESCE($2::uuid, $3::uuid)`,
      [variantId, storeId, NO_STORE],
    );

    const { rows } = await tx.query(
      `INSERT INTO variant_prices (org_id, variant_id, store_id, kind, price_minor, created_by)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, 'regular', $3, $4)
       RETURNING id, variant_id, store_id, kind, price_minor::text, effective_from, effective_to`,
      [variantId, storeId, priceMinor, actorUserId],
    );
    const price = rows[0]!;

    await this.audit.record(tx, {
      action: 'product.price_change',
      entityType: 'variant_price',
      entityId: price.id,
      actorUserId,
      newValue: { variant_id: variantId, store_id: storeId, price_minor: price.price_minor },
    });

    return price;
  }
}
