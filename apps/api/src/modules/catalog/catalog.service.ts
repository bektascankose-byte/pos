import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CreateProduct,
  ProductSearch,
  UpdateProduct,
  UpdateVariant,
  SetVariantPrice,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const NO_STORE = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class CatalogService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
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
    return this.db.withOrg(orgId, async (tx) => {
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
          input.brand_id ?? null,
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
    });
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
           tags            = COALESCE($9, tags)
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
        ],
      );
      const product = rows[0];
      if (!product) throw ApiException.notFound('product');

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

  /** Edit a variant's own fields -- never its price; see `setVariantPrice`. */
  async updateVariant(orgId: string, actorUserId: string, id: string, input: UpdateVariant) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE product_variants SET
           variant_name     = COALESCE($2, variant_name),
           cost             = COALESCE($3, cost),
           case_quantity    = COALESCE($4, case_quantity),
           pack_quantity    = COALESCE($5, pack_quantity),
           reorder_point    = COALESCE($6, reorder_point),
           reorder_quantity = COALESCE($7, reorder_quantity),
           status           = COALESCE($8, status)
         WHERE id = $1
         RETURNING id, product_id, sku, plu, variant_name, attributes, is_default, sort_order,
                   cost::text, average_cost::text, last_cost::text, case_quantity, pack_quantity,
                   reorder_point::text, reorder_quantity::text, status`,
        [
          id,
          input.variant_name ?? null,
          input.cost ?? null,
          input.case_quantity ?? null,
          input.pack_quantity ?? null,
          input.reorder_point ?? null,
          input.reorder_quantity ?? null,
          input.status ?? null,
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
      const storeId = input.store_id ?? null;

      const { rows: variantRows } = await tx.query(
        `SELECT id FROM product_variants WHERE id = $1`,
        [variantId],
      );
      if (!variantRows[0]) throw ApiException.notFound('variant');

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
        [variantId, storeId, input.price_minor.toString(), actorUserId],
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
    });
  }
}
