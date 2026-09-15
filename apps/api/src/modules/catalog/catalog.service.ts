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
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { AiService } from '../../platform/ai/ai.service.js';

const NO_STORE = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
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
        `SELECT v.id AS variant_id, v.sku, v.variant_name,
                p.id AS product_id, p.name AS product_name,
                br.name AS brand_name,
                v.cost::text,
                pr.price_minor::text,
                COALESCE(il.on_hand, 0)::text   AS on_hand,
                COALESCE(il.available, 0)::text AS available
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN brands br ON br.id = p.brand_id
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
   * Add one variant to a product that already exists -- another flavor of
   * something already on the shelf, discovered after the product itself was
   * created. Never the product's default variant (`is_default` is decided
   * once, at the product's own creation) and always sorted after every
   * existing variant.
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
    const { rows: variantRows } = await tx.query(`SELECT id FROM product_variants WHERE id = $1`, [
      variantId,
    ]);
    if (!variantRows[0]) throw ApiException.notFound('variant');

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO variant_barcodes (org_id, variant_id, barcode, kind, units, is_primary)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)
       RETURNING id`,
      [
        variantId,
        input.barcode,
        input.kind ?? 'upc',
        input.units ?? '1',
        input.is_primary ?? false,
      ],
    );

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
   * Drop an alternate or carton code. The primary is deliberately not
   * removable here: a variant whose primary code is gone still appears in
   * search and still fails at the counter, which is the exact state
   * `createProduct` above refuses to create in the first place. Changing which
   * code is primary is a different operation than deleting one.
   */
  async removeBarcodeFromVariant(orgId: string, actorUserId: string, barcodeId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ variant_id: string; barcode: string; is_primary: boolean }>(
        `SELECT variant_id, barcode, is_primary FROM variant_barcodes WHERE id = $1`,
        [barcodeId],
      );
      const existing = rows[0];
      if (!existing) throw ApiException.notFound('barcode');
      if (existing.is_primary) {
        throw new ApiException(
          'validation_failed',
          "that is this item's primary code -- it can't be removed",
          { retryable: false },
        );
      }

      await tx.query(`DELETE FROM variant_barcodes WHERE id = $1`, [barcodeId]);

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
   * Used only from within `createProductTx`, for a brand typed as free text
   * rather than picked from the existing list. Case-insensitive: "Sherpa"
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

      return {
        ...product,
        compliance: complianceRows[0] ?? null,
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
          input.brand_id ?? null,
          input.category_id ?? null,
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
    return this.db.withOrg(orgId, async (tx) => {
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

      return variant;
    });
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
   * `variant_ids` forms (or reuses) a group and stamps it on every variant
   * given -- a group is formed by pricing, not declared ahead of time.
   * `price_group_id` reprices whichever variants currently carry that group,
   * with no need to re-select them. Repeating the same `variant_ids`
   * selection reuses its existing shared group rather than minting a new
   * one each time and orphaning the last one -- the common case of
   * "reprice this same set again" should not leave debris behind.
   */
  async bulkSetPrice(orgId: string, actorUserId: string, input: BulkPriceVariants) {
    return this.db.withOrg(orgId, async (tx) => {
      let variantIds: string[];
      let priceGroupId: string;

      if (input.price_group_id) {
        priceGroupId = input.price_group_id;
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM product_variants WHERE price_group_id = $1`,
          [priceGroupId],
        );
        variantIds = rows.map((r) => r.id);
        if (variantIds.length === 0) throw ApiException.notFound('price group');
      } else {
        variantIds = input.variant_ids!;

        const { rows: currentRows } = await tx.query<{ id: string; price_group_id: string | null }>(
          `SELECT id, price_group_id FROM product_variants WHERE id = ANY($1::uuid[])`,
          [variantIds],
        );
        if (currentRows.length !== variantIds.length) throw ApiException.notFound('variant');

        // Reuse an existing group only when every given variant already
        // shares the *same* one AND that group's membership is exactly this
        // set -- anything else (fresh variants, a subset, mixed groups)
        // mints a new one and re-stamps, which is the unsurprising reading
        // of "form a group from exactly these variants."
        const distinctGroups = new Set(
          currentRows.map((r) => r.price_group_id).filter((g): g is string => g !== null),
        );
        let reusableGroupId: string | null = null;
        if (distinctGroups.size === 1) {
          const candidate = [...distinctGroups][0]!;
          const { rows: memberRows } = await tx.query<{ id: string }>(
            `SELECT id FROM product_variants WHERE price_group_id = $1`,
            [candidate],
          );
          const sameSet =
            memberRows.length === variantIds.length && memberRows.every((r) => variantIds.includes(r.id));
          if (sameSet) reusableGroupId = candidate;
        }

        if (reusableGroupId) {
          priceGroupId = reusableGroupId;
        } else {
          const { rows: groupRows } = await tx.query<{ id: string }>(
            `INSERT INTO price_groups (org_id, created_by)
             VALUES (current_setting('app.org_id')::uuid, $1)
             RETURNING id`,
            [actorUserId],
          );
          priceGroupId = groupRows[0]!.id;

          await tx.query(
            `UPDATE product_variants SET price_group_id = $2 WHERE id = ANY($1::uuid[])`,
            [variantIds, priceGroupId],
          );
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

  async listPriceCategories(orgId: string, storeId: string | null) {
    return this.db.withOrg(orgId, async (tx) => {
      // `mismatch_count` is the point of grouping prices in the first place:
      // how many members have drifted off the price the rest of the group
      // shares. The group's own price is taken as the most common one among
      // its members (`mode()`), and a member with no price at all counts as
      // mismatched -- it's exactly as wrong at the counter as one priced
      // differently.
      const { rows } = await tx.query(
        `WITH member_prices AS (
           SELECT pg.id AS group_id, pg.name, pg.created_at,
                  v.id AS variant_id, pr.price_minor
           FROM price_groups pg
           LEFT JOIN product_variants v ON v.price_group_id = pg.id
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
           WHERE pg.org_id = $1
         ),
         group_mode AS (
           SELECT group_id, mode() WITHIN GROUP (ORDER BY price_minor) AS common_price
           FROM member_prices
           WHERE price_minor IS NOT NULL
           GROUP BY group_id
         )
         SELECT mp.group_id AS id, mp.name, mp.created_at,
                count(mp.variant_id)::int AS member_count,
                (CASE WHEN count(DISTINCT mp.price_minor) = 1 THEN min(mp.price_minor) ELSE NULL END)::text
                  AS current_price_minor,
                count(mp.variant_id) FILTER (
                  WHERE mp.price_minor IS DISTINCT FROM gm.common_price
                )::int AS mismatch_count
         FROM member_prices mp
         LEFT JOIN group_mode gm ON gm.group_id = mp.group_id
         GROUP BY mp.group_id, mp.name, mp.created_at, gm.common_price
         ORDER BY mp.created_at DESC`,
        [orgId, storeId],
      );
      return rows;
    });
  }

  async getPriceCategory(orgId: string, id: string, storeId: string | null) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: categoryRows } = await tx.query(
        `SELECT pg.id, pg.name, pg.created_at,
                count(v.id)::int AS member_count,
                (CASE WHEN count(DISTINCT pr.price_minor) = 1 THEN min(pr.price_minor) ELSE NULL END)::text
                  AS current_price_minor
         FROM price_groups pg
         LEFT JOIN product_variants v ON v.price_group_id = pg.id
         LEFT JOIN LATERAL (
           SELECT price_minor FROM variant_prices
           WHERE variant_id = v.id
             AND (store_id = $3 OR store_id IS NULL)
             AND kind = 'regular'
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())
           ORDER BY store_id NULLS LAST, effective_from DESC
           LIMIT 1
         ) pr ON true
         WHERE pg.id = $1 AND pg.org_id = $2
         GROUP BY pg.id`,
        [id, orgId, storeId],
      );
      const category = categoryRows[0];
      if (!category) throw ApiException.notFound('price category');

      const { rows: members } = await tx.query(
        `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name,
                v.variant_name, v.sku, pr.price_minor::text AS price_minor
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
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
         WHERE v.price_group_id = $1
         ORDER BY p.name, v.variant_name`,
        [id, storeId],
      );

      return { ...category, members };
    });
  }

  /**
   * Stamps `price_group_id` on every given variant, without touching price --
   * building a category's membership is separate from setting its price
   * (`bulkSetPrice`, unchanged, does that). A variant carries at most one
   * price category at a time, so this silently moves it out of any other.
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

      const { rows: variantRows } = await tx.query<{ id: string }>(
        `SELECT id FROM product_variants WHERE id = ANY($1::uuid[])`,
        [variantIds],
      );
      if (variantRows.length !== variantIds.length) throw ApiException.notFound('variant');

      await tx.query(`UPDATE product_variants SET price_group_id = $2 WHERE id = ANY($1::uuid[])`, [
        variantIds,
        categoryId,
      ]);

      await this.audit.record(tx, {
        action: 'product.price_category_add_member',
        entityType: 'price_group',
        entityId: categoryId,
        actorUserId,
        newValue: { variant_ids: variantIds },
      });

      return { price_group_id: categoryId, added: variantIds.length };
    });
  }

  async removeVariantFromPriceCategory(orgId: string, actorUserId: string, variantId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      // `RETURNING price_group_id` on the UPDATE below would reflect the row
      // *after* it's set to NULL, always -- never the value that justified the
      // match. Joining against a pre-update snapshot is what lets RETURNING
      // report the old value instead.
      const { rows } = await tx.query<{ price_group_id: string | null }>(
        `UPDATE product_variants v SET price_group_id = NULL
         FROM (SELECT id, price_group_id FROM product_variants WHERE id = $1 AND price_group_id IS NOT NULL) AS old
         WHERE v.id = old.id
         RETURNING old.price_group_id`,
        [variantId],
      );
      const categoryId = rows[0]?.price_group_id;
      if (!categoryId) throw ApiException.notFound('price category member');

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
   * `addVariantsToPriceCategory` -- just returning enough about the match for
   * the caller to show an on-page confirmation.
   */
  async scanAddToPriceCategory(orgId: string, actorUserId: string, categoryId: string, code: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: categoryRows } = await tx.query(`SELECT id FROM price_groups WHERE id = $1`, [categoryId]);
      if (!categoryRows[0]) throw ApiException.notFound('price category');

      const match = await this.findVariantBySkuOrBarcodeTx(tx, code);
      if (!match) throw ApiException.notFound(`item for code "${code}"`);

      await tx.query(`UPDATE product_variants SET price_group_id = $2 WHERE id = $1`, [match.id, categoryId]);

      const { rows } = await tx.query<{ product_name: string; variant_name: string | null; sku: string }>(
        `SELECT p.name AS product_name, v.variant_name, v.sku
         FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE v.id = $1`,
        [match.id],
      );

      await this.audit.record(tx, {
        action: 'product.price_category_add_member',
        entityType: 'price_group',
        entityId: categoryId,
        actorUserId,
        newValue: { variant_id: match.id, via: 'scan' },
      });

      return { variant_id: match.id, ...rows[0]! };
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
  private async closeAndOpenPrice(
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
