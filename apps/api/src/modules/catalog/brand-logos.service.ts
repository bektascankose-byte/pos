import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { AiService } from '../../platform/ai/ai.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { StockImageService } from './stock-image.service.js';

/** The same three a product photo may be. Matches the table's own check. */
const EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

/**
 * A logo is drawn a few centimetres wide on a till. A file bigger than this
 * is a banner or a poster that happens to have the logo on it, and every
 * register would download it.
 */
const MAX_BYTES = 1.5 * 1024 * 1024;

export interface BrandLogoRow {
  id: string;
  brand_id: string;
  source_url: string | null;
  created_at: string;
}

/**
 * Brand logos: found on the web, uploaded by hand, served to the registers.
 *
 * Kept apart from `ProductImagesService` because a logo belongs to a brand,
 * not to anything that is sold, and because it reaches the registers on its
 * own schedule: see 0037 for why a new logo does not wait for Send.
 */
@Injectable()
export class BrandLogosService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
    private readonly ai: AiService,
    private readonly stockImages: StockImageService,
  ) {}

  /** Every active brand, its logo if it has one, and how many items on sale carry it. A to Z. */
  async list(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT b.id, b.name, l.id AS logo_id, l.source_url AS logo_source_url,
                (SELECT count(*)::int FROM products p
                 WHERE p.brand_id = b.id AND p.status = 'active'
                   AND EXISTS (SELECT 1 FROM product_variants v
                               WHERE v.product_id = p.id AND v.status = 'active')) AS product_count
         FROM brands b
         LEFT JOIN brand_logos l ON l.brand_id = b.id
         WHERE b.status = 'active'
         ORDER BY lower(b.name)`,
      );
      return rows;
    });
  }

  /**
   * Where this brand's logo might be found, best first: the logo files the AI
   * found on the web, then the icons the brand's own website declares.
   *
   * Addresses only. The back office fetches each one through the stock image
   * proxy, scales it and checks it would actually show on a till's light
   * folder before uploading it: a logo drawn in white on a clear background is
   * common on brand websites (Geek Bar's is) and invisible on a till, and
   * telling that apart needs the pixels, which the browser's canvas has and
   * this server, with no image library, does not.
   *
   * A brand that already has a logo keeps it unless `replace` is asked for, so
   * drafting a second Foger product never swaps out a logo somebody chose.
   */
  async candidates(orgId: string, brandId: string, replace: boolean) {
    const brand = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ name: string; logo_id: string | null; hint: string | null }>(
        `SELECT b.name, l.id AS logo_id,
                (SELECT p.name FROM products p
                 WHERE p.brand_id = b.id AND p.status = 'active'
                 ORDER BY p.created_at DESC LIMIT 1) AS hint
         FROM brands b
         LEFT JOIN brand_logos l ON l.brand_id = b.id
         WHERE b.id = $1`,
        [brandId],
      );
      return rows[0];
    });
    if (!brand) throw ApiException.notFound('brand');
    if (brand.logo_id && !replace) return { kept: true, candidates: [] };

    const answer = await this.ai.findBrandLogo({ brand_name: brand.name, product_hint: brand.hint });

    // Only direct image addresses. A page's og:image, which product photos
    // fall back to, is a banner or a press shot far more often than a logo.
    const candidates: { url: string; source: string }[] = answer.logos
      .filter((logo) => logo.image_url)
      .map((logo) => ({ url: logo.image_url!, source: logo.page_url ?? logo.image_url! }));
    if (answer.website) {
      for (const icon of await this.stockImages.readSiteIcons(answer.website)) {
        candidates.push({ url: icon, source: answer.website });
      }
    }
    const seen = new Set<string>();
    return {
      kept: false,
      candidates: candidates.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url)),
    };
  }

  /**
   * Keep an image as the brand's logo, replacing whatever it had: one somebody
   * chose themselves, or one the back office prepared from a found candidate,
   * in which case `sourceUrl` says where it came from.
   */
  async upload(
    orgId: string,
    actorUserId: string,
    brandId: string,
    file: { buffer: Buffer; contentType: string },
    sourceUrl: string | null,
  ) {
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new ApiException(
        'validation_failed',
        `that logo is ${(file.buffer.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is 1.5MB`,
        { retryable: false },
      );
    }
    return { logo: await this.store(orgId, actorUserId, brandId, file, sourceUrl) };
  }

  async remove(orgId: string, actorUserId: string, brandId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `DELETE FROM brand_logos WHERE brand_id = $1 RETURNING id`,
        [brandId],
      );
      if (!rows[0]) throw ApiException.notFound('brand logo');
      // The object stays in the bucket, as a removed product photo's does: an
      // orphan costs a few kilobytes, a mistake with the bytes gone cannot be
      // undone.
      await this.audit.record(tx, {
        action: 'catalog.brand_logo.remove',
        entityType: 'brand',
        entityId: brandId,
        actorUserId,
        oldValue: { logo_id: rows[0].id },
      });
      return { removed: true };
    });
  }

  /**
   * The bytes. The id names a row, never a storage key, so a caller can only
   * ever reach a logo their own organization owns.
   */
  async read(orgId: string, logoId: string) {
    const row = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ object_key: string; content_type: string }>(
        `SELECT object_key, content_type FROM brand_logos WHERE id = $1`,
        [logoId],
      );
      return rows[0];
    });
    if (!row) throw ApiException.notFound('brand logo');
    return { body: await this.storage.get(row.object_key), contentType: row.content_type };
  }

  private async current(orgId: string, brandId: string): Promise<BrandLogoRow | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<BrandLogoRow>(
        `SELECT id, brand_id, source_url, created_at FROM brand_logos WHERE brand_id = $1`,
        [brandId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Keep these bytes as the brand's logo.
   *
   * The old row goes and a new one with a new id is written, rather than the
   * old one being pointed at new bytes: a logo is served as immutable, so its
   * address must never start meaning a different picture.
   */
  private async store(
    orgId: string,
    actorUserId: string,
    brandId: string,
    file: { buffer: Buffer; contentType: string },
    sourceUrl: string | null,
  ): Promise<BrandLogoRow> {
    const extension = EXTENSIONS.get(file.contentType);
    if (!extension) {
      throw new ApiException(
        'validation_failed',
        `"${file.contentType}" isn't an image this accepts -- send a PNG, JPEG or WebP`,
        { retryable: false },
      );
    }

    return this.db.withOrg(orgId, async (tx) => {
      const { rows: brandRows } = await tx.query(`SELECT id FROM brands WHERE id = $1`, [brandId]);
      if (!brandRows[0]) throw ApiException.notFound('brand');

      const id = randomUUID();
      const key = `brands/${brandId}/${id}.${extension}`;
      await this.storage.put(key, file.buffer, file.contentType);

      await tx.query(`DELETE FROM brand_logos WHERE brand_id = $1`, [brandId]);
      const { rows } = await tx.query<BrandLogoRow>(
        `INSERT INTO brand_logos (id, org_id, brand_id, object_key, content_type, bytes, source_url, created_by)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7)
         RETURNING id, brand_id, source_url, created_at`,
        [id, brandId, key, file.contentType, file.buffer.byteLength, sourceUrl, actorUserId],
      );

      await this.audit.record(tx, {
        action: 'catalog.brand_logo.set',
        entityType: 'brand',
        entityId: brandId,
        actorUserId,
        newValue: { logo_id: id, source_url: sourceUrl, bytes: file.buffer.byteLength },
      });

      return rows[0]!;
    });
  }
}
