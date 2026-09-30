import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PosPending, PosPendingProduct, SendToPosResult } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import {
  describeProduct,
  planSend,
  type BarcodeRow,
  type Names,
  type PriceRow,
  type VariantPair,
  type VariantPayload,
} from './pos-release-diff.js';

interface PairRow {
  product_id: string;
  variant_id: string;
  live_payload: VariantPayload | null;
  live_barcodes: BarcodeRow[] | null;
  live_prices: PriceRow[] | null;
  sent_payload: VariantPayload | null;
  sent_barcodes: BarcodeRow[] | null;
  sent_prices: PriceRow[] | null;
}

/**
 * Every variant of the given products (all products when $1 is null) on both
 * sides: as the registers would get it now, and as they were last sent it.
 *
 * The sent prices drop anything that has since expired, exactly as the live
 * side does, so a sale price that ran out on its own is not a change anybody
 * has to send.
 */
const PAIRS_SQL = `
  SELECT COALESCE(l.product_id, s.product_id) AS product_id,
         COALESCE(l.variant_id, s.variant_id) AS variant_id,
         l.payload  AS live_payload,
         l.barcodes AS live_barcodes,
         l.prices   AS live_prices,
         s.payload  AS sent_payload,
         s.barcodes AS sent_barcodes,
         CASE WHEN s.variant_id IS NOT NULL THEN COALESCE((
           SELECT jsonb_agg(p ORDER BY p->>'id')
           FROM jsonb_array_elements(s.prices) p
           WHERE p->>'effective_to' IS NULL OR (p->>'effective_to')::timestamptz > now()
         ), '[]'::jsonb) END AS sent_prices
  FROM (SELECT * FROM pos_live_variants
        WHERE $1::uuid[] IS NULL OR product_id = ANY($1::uuid[])) l
  FULL JOIN (SELECT * FROM pos_catalog_variants
             WHERE $1::uuid[] IS NULL OR product_id = ANY($1::uuid[])) s
    ON s.variant_id = l.variant_id`;

function toPair(row: PairRow): VariantPair {
  return {
    variant_id: row.variant_id,
    product_id: row.product_id,
    live: row.live_payload
      ? { payload: row.live_payload, barcodes: row.live_barcodes ?? [], prices: row.live_prices ?? [] }
      : null,
    sent: row.sent_payload
      ? { payload: row.sent_payload, barcodes: row.sent_barcodes ?? [], prices: row.sent_prices ?? [] }
      : null,
  };
}

/**
 * Send to POS (migration 0034).
 *
 * The registers sell from what was last sent, not from what is being edited.
 * This is the page's two halves: what is waiting and whether it can go, and
 * the button that sends it.
 */
@Injectable()
export class PosReleaseService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Every product with something waiting to go to the registers, most recently edited first. */
  async pending(orgId: string): Promise<PosPending> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<PairRow>(
        `WITH pairs AS (${PAIRS_SQL}),
         waiting AS (
           SELECT DISTINCT product_id FROM pairs
           WHERE live_payload  IS DISTINCT FROM sent_payload
              OR live_barcodes IS DISTINCT FROM sent_barcodes
              OR live_prices   IS DISTINCT FROM sent_prices
         )
         SELECT * FROM pairs WHERE product_id IN (SELECT product_id FROM waiting)`,
        [null],
      );

      const byProduct = new Map<string, VariantPair[]>();
      for (const row of rows) {
        const list = byProduct.get(row.product_id) ?? [];
        list.push(toPair(row));
        byProduct.set(row.product_id, list);
      }

      const names = await this.names(tx);
      const productIds = [...byProduct.keys()];
      const { rows: meta } = await tx.query<{
        id: string;
        name: string;
        brand_name: string | null;
        updated_at: Date;
        image_id: string | null;
      }>(
        `SELECT p.id, p.name, b.name AS brand_name, p.updated_at,
                COALESCE(
                  (SELECT i.id FROM product_images i
                    WHERE i.product_id = p.id
                    ORDER BY i.sort_order, i.created_at LIMIT 1),
                  (SELECT i.id FROM product_images i
                    JOIN product_variants v ON v.id = i.variant_id
                    WHERE v.product_id = p.id
                    ORDER BY v.sort_order, i.sort_order, i.created_at LIMIT 1)
                ) AS image_id
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.id = ANY($1::uuid[])`,
        [productIds],
      );
      const metaById = new Map(meta.map((m) => [m.id, m]));

      const now = new Date();
      const products: PosPendingProduct[] = [];
      for (const [productId, pairs] of byProduct) {
        const diff = describeProduct(pairs, names, now);
        if (diff.changes.length === 0) continue;
        const m = metaById.get(productId);
        const any = (pairs.find((p) => p.live) ?? pairs[0])!;
        const payload = (any.live ?? any.sent)!.payload;
        products.push({
          product_id: productId,
          product_name: m?.name ?? payload.product_name,
          brand_name: m?.brand_name ?? payload.brand_name,
          image_id: m?.image_id ?? null,
          kind: diff.kind,
          changes: diff.changes,
          problems: diff.problems,
          sendable: diff.sendable,
          variant_count: pairs.filter((p) => p.live).length,
          updated_at: m ? m.updated_at.toISOString() : null,
        });
      }
      products.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

      const { rows: last } = await tx.query<{
        created_at: Date;
        released_by: string | null;
        product_count: number;
      }>(
        `SELECT r.created_at,
                COALESCE(u.display_name, u.full_name) AS released_by,
                cardinality(r.product_ids) AS product_count
         FROM pos_releases r
         LEFT JOIN users u ON u.id = r.released_by
         ORDER BY r.created_at DESC
         LIMIT 1`,
      );
      const release = last[0];

      return {
        products,
        last_release: release
          ? {
              created_at: release.created_at.toISOString(),
              released_by: release.released_by,
              product_count: Number(release.product_count),
            }
          : null,
      };
    });
  }

  /**
   * Send these products to the registers.
   *
   * Per variant, not per product: the flavors that are ready go, and one
   * still missing its barcode stays behind (off the registers if it was never
   * on them, as it was if it was) without stopping the rest. What stayed and
   * why comes back, so the page can say so.
   *
   * The rows written are the exact state that was checked, passed back in as
   * JSON, rather than re-read from the view: an edit saved between the check
   * and the write cannot slip an unready variant onto the registers.
   */
  async send(orgId: string, actorUserId: string, productIds: string[]): Promise<SendToPosResult> {
    return this.db.withOrg(orgId, async (tx) => {
      // One send at a time per organization. Two people pressing Send on the
      // same product at once would otherwise both delete and both insert.
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('pos_release:' || current_setting('app.org_id'), 0))`,
      );

      const { rows } = await tx.query<PairRow>(PAIRS_SQL, [productIds]);
      const pairs = rows.map(toPair);
      const plan = planSend(pairs, new Date());

      const touched = new Set<string>();
      const byVariant = new Map(pairs.map((p) => [p.variant_id, p]));
      for (const id of [...plan.upsert, ...plan.remove]) touched.add(byVariant.get(id)!.product_id);

      if (touched.size > 0) {
        await tx.query(`DELETE FROM pos_catalog_variants WHERE variant_id = ANY($1::uuid[])`, [
          [...plan.upsert, ...plan.remove],
        ]);
        if (plan.upsert.length > 0) {
          const outgoing = plan.upsert.map((id) => {
            const live = byVariant.get(id)!.live!;
            return {
              variant_id: id,
              product_id: live.payload.product_id,
              payload: live.payload,
              barcodes: live.barcodes,
              prices: live.prices,
            };
          });
          await tx.query(
            `INSERT INTO pos_catalog_variants
               (variant_id, org_id, product_id, payload, barcodes, prices, released_by)
             SELECT (r->>'variant_id')::uuid, current_setting('app.org_id')::uuid,
                    (r->>'product_id')::uuid, r->'payload', r->'barcodes', r->'prices', $2
             FROM jsonb_array_elements($1::jsonb) r`,
            [JSON.stringify(outgoing), actorUserId],
          );
        }

        const { rows: release } = await tx.query<{ id: string }>(
          `INSERT INTO pos_releases
             (org_id, product_ids, variants_added, variants_changed, variants_removed, released_by)
           VALUES (current_setting('app.org_id')::uuid, $1::uuid[], $2, $3, $4, $5)
           RETURNING id`,
          [[...touched], plan.added, plan.changed, plan.remove.length, actorUserId],
        );

        await this.audit.record(tx, {
          action: 'catalog.send_to_pos',
          entityType: 'pos_release',
          entityId: release[0]!.id,
          actorUserId,
          newValue: {
            product_ids: [...touched],
            variants_added: plan.added,
            variants_changed: plan.changed,
            variants_removed: plan.remove.length,
            held_back: plan.heldBack.length,
          },
        });
      }

      return {
        sent: touched.size,
        variants_added: plan.added,
        variants_changed: plan.changed,
        variants_removed: plan.remove.length,
        held_back: plan.heldBack,
      };
    });
  }

  private async names(tx: PoolClient): Promise<Names> {
    const [categories, taxCategories, stores] = await Promise.all([
      tx.query<{ id: string; name: string }>(`SELECT id, name FROM categories`),
      tx.query<{ id: string; name: string }>(`SELECT id, name FROM tax_categories`),
      tx.query<{ id: string; name: string }>(`SELECT id, name FROM stores`),
    ]);
    const map = (r: { rows: { id: string; name: string }[] }) => new Map(r.rows.map((x) => [x.id, x.name]));
    return { categories: map(categories), taxCategories: map(taxCategories), stores: map(stores) };
  }
}
