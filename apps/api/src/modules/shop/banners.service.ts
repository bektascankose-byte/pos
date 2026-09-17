import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  BannerPlacement,
  CreateBannerFields,
  ShopBanner,
  StorefrontBanner,
  UpdateBanner,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { imageSize } from '../../platform/storage/image-size.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';
import { isWithin, matches, ShopCatalogService, type PurchasableTargets } from './shop-catalog.service.js';

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const VIDEO_TYPES = new Map([
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
]);

export type BannerMediaKind = 'image' | 'mobile' | 'video';

interface BannerRow {
  id: string;
  placement: BannerPlacement;
  title: string;
  headline: string | null;
  body: string | null;
  cta_label: string | null;
  link_kind: StorefrontBanner['link_kind'];
  link_value: string | null;
  image_key: string;
  image_width: number;
  image_height: number;
  image_mobile_key: string | null;
  image_mobile_width: number | null;
  image_mobile_height: number | null;
  video_key: string | null;
  video_bytes: string | null;
  alt_text: string;
  advertises_nicotine: boolean;
  hide_when_unavailable: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  sort_order: number;
  status: StorefrontBanner['status'];
  source_note: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, placement, title, headline, body, cta_label, link_kind, link_value,
  image_key, image_width, image_height, image_mobile_key, image_mobile_width, image_mobile_height,
  video_key, video_bytes::text, alt_text, advertises_nicotine, hide_when_unavailable,
  starts_at, ends_at, sort_order, status, source_note, created_at, updated_at`;

type File = { buffer: Buffer; contentType: string };

/**
 * Brand artwork on the website.
 *
 * The bytes live in object storage and never leave through a storage URL:
 * shoppers get them through the shop routes, which serve a banner's media only
 * while the banner itself is showing, and staff through the back office.
 *
 * A banner shows only while three things hold: it is switched on, today is in
 * its date window, and -- unless someone chose otherwise -- whatever it links
 * to has something in stock online. The back office is told which of those is
 * stopping a banner, in words.
 */
@Injectable()
export class BannersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
    private readonly catalog: ShopCatalogService,
  ) {}

  async list(orgId: string, storeId: string): Promise<StorefrontBanner[]> {
    const { rows, slugs } = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<BannerRow>(
        `SELECT ${COLUMNS} FROM storefront_banners WHERE status <> 'archived'
         ORDER BY placement, sort_order, created_at`,
      );
      return { rows, slugs: await this.categorySlugsTx(tx) };
    });
    const targets = await this.catalog.purchasable({ clientId: 'back-office', orgId, storeId });
    const now = new Date();
    return rows.map((row) => this.toView(row, visibility(row, targets, slugs, now)));
  }

  async create(orgId: string, actorUserId: string, fields: CreateBannerFields, image: File, mobile: File | null) {
    const wide = this.checkImage(image, 'the banner image');
    const tall = mobile ? this.checkImage(mobile, 'the phone image') : null;

    return this.db.withOrg(orgId, async (tx) => {
      await this.checkLinkTx(tx, fields.link_kind, fields.link_value ?? null);

      const id = randomUUID();
      const imageKey = `banners/${id}/wide.${wide.type === 'jpeg' ? 'jpg' : wide.type}`;
      await this.storage.put(imageKey, image.buffer, image.contentType);
      let mobileKey: string | null = null;
      if (mobile && tall) {
        mobileKey = `banners/${id}/phone.${tall.type === 'jpeg' ? 'jpg' : tall.type}`;
        await this.storage.put(mobileKey, mobile.buffer, mobile.contentType);
      }

      await tx.query(
        `INSERT INTO storefront_banners
           (id, org_id, placement, title, headline, body, cta_label, link_kind, link_value,
            image_key, image_width, image_height, image_mobile_key, image_mobile_width, image_mobile_height,
            alt_text, advertises_nicotine, hide_when_unavailable, starts_at, ends_at, sort_order, source_note, created_by)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19,
                 COALESCE((SELECT max(sort_order) + 1 FROM storefront_banners WHERE placement = $2::banner_placement), 0),
                 $20, $21)`,
        [
          id,
          fields.placement,
          fields.title,
          fields.headline ?? null,
          fields.body ?? null,
          fields.cta_label ?? null,
          fields.link_kind,
          fields.link_kind === 'none' ? null : (fields.link_value ?? null),
          imageKey,
          wide.width,
          wide.height,
          mobileKey,
          tall?.width ?? null,
          tall?.height ?? null,
          fields.alt_text,
          fields.advertises_nicotine,
          fields.hide_when_unavailable,
          fields.starts_at ?? null,
          fields.ends_at ?? null,
          fields.source_note ?? null,
          actorUserId,
        ],
      );
      await this.audit.record(tx, {
        action: 'storefront.banner.create',
        entityType: 'storefront_banner',
        entityId: id,
        actorUserId,
        newValue: { placement: fields.placement, title: fields.title, link_kind: fields.link_kind, link_value: fields.link_value },
      });
      return { id };
    });
  }

  /** A short silent video to play in place of the image, where motion is welcome. */
  async attachVideo(orgId: string, actorUserId: string, id: string, file: File) {
    const extension = VIDEO_TYPES.get(file.contentType);
    if (!extension) {
      throw new ApiException('validation_failed', 'send the video as MP4 or WebM', { retryable: false });
    }
    if (file.buffer.byteLength > MAX_VIDEO_BYTES) {
      throw new ApiException(
        'validation_failed',
        `that video is ${(file.buffer.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_VIDEO_BYTES / 1024 / 1024}MB`,
        { retryable: false },
      );
    }
    return this.db.withOrg(orgId, async (tx) => {
      await this.rowTx(tx, id);
      const key = `banners/${id}/video-${randomUUID()}.${extension}`;
      await this.storage.put(key, file.buffer, file.contentType);
      await tx.query(`UPDATE storefront_banners SET video_key = $2, video_bytes = $3 WHERE id = $1`, [
        id,
        key,
        file.buffer.byteLength,
      ]);
      await this.audit.record(tx, {
        action: 'storefront.banner.video',
        entityType: 'storefront_banner',
        entityId: id,
        actorUserId,
        newValue: { bytes: file.buffer.byteLength },
      });
      return { id };
    });
  }

  async update(orgId: string, actorUserId: string, id: string, input: UpdateBanner) {
    return this.db.withOrg(orgId, async (tx) => {
      const before = await this.rowTx(tx, id);
      const set = (key: keyof UpdateBanner) => input[key] !== undefined;
      await tx.query(
        `UPDATE storefront_banners SET
           title                 = CASE WHEN $2  THEN $3  ELSE title END,
           headline              = CASE WHEN $4  THEN $5  ELSE headline END,
           body                  = CASE WHEN $6  THEN $7  ELSE body END,
           cta_label             = CASE WHEN $8  THEN $9  ELSE cta_label END,
           alt_text              = CASE WHEN $10 THEN $11 ELSE alt_text END,
           advertises_nicotine   = CASE WHEN $12 THEN $13::boolean ELSE advertises_nicotine END,
           hide_when_unavailable = CASE WHEN $14 THEN $15::boolean ELSE hide_when_unavailable END,
           starts_at             = CASE WHEN $16 THEN $17::timestamptz ELSE starts_at END,
           ends_at               = CASE WHEN $18 THEN $19::timestamptz ELSE ends_at END,
           sort_order            = CASE WHEN $20 THEN $21::smallint ELSE sort_order END,
           status                = CASE WHEN $22 THEN $23::entity_status ELSE status END
         WHERE id = $1`,
        [
          id,
          set('title'), input.title ?? null,
          set('headline'), input.headline ?? null,
          set('body'), input.body ?? null,
          set('cta_label'), input.cta_label ?? null,
          set('alt_text'), input.alt_text ?? null,
          set('advertises_nicotine'), input.advertises_nicotine ?? null,
          set('hide_when_unavailable'), input.hide_when_unavailable ?? null,
          set('starts_at'), input.starts_at ?? null,
          set('ends_at'), input.ends_at ?? null,
          set('sort_order'), input.sort_order ?? null,
          set('status'), input.status ?? null,
        ],
      );
      await this.audit.record(tx, {
        action: 'storefront.banner.update',
        entityType: 'storefront_banner',
        entityId: id,
        actorUserId,
        oldValue: { status: before.status, advertises_nicotine: before.advertises_nicotine },
        newValue: input,
      });
      return { id };
    });
  }

  /** Taken off the website and out of the list. The artwork stays in storage, as product photos do. */
  async archive(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.rowTx(tx, id);
      await tx.query(`UPDATE storefront_banners SET status = 'archived' WHERE id = $1`, [id]);
      await this.audit.record(tx, {
        action: 'storefront.banner.archive',
        entityType: 'storefront_banner',
        entityId: id,
        actorUserId,
      });
      return { id };
    });
  }

  /** The banners a shopper sees in one place on the page, in order. */
  async forShop(shop: ShopClient, placement: BannerPlacement, brandId?: string): Promise<ShopBanner[]> {
    const { rows, slugs } = await this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<BannerRow>(
        `SELECT ${COLUMNS} FROM storefront_banners
         WHERE status = 'active' AND placement = $1 AND ($2::text IS NULL OR (link_kind = 'brand' AND link_value = $2))
         ORDER BY sort_order, created_at`,
        [placement, brandId ?? null],
      );
      return { rows, slugs: await this.categorySlugsTx(tx) };
    });
    if (rows.length === 0) return [];
    const targets = await this.catalog.purchasable(shop);
    const now = new Date();
    return rows
      .filter((row) => visibility(row, targets, slugs, now).showing)
      .map((row) => ({
        id: row.id,
        placement: row.placement,
        headline: row.headline,
        body: row.body,
        cta_label: row.cta_label,
        link: row.link_kind === 'none' || !row.link_value ? null : { kind: row.link_kind, value: row.link_value },
        image: { width: row.image_width, height: row.image_height },
        mobile_image:
          row.image_mobile_key && row.image_mobile_width && row.image_mobile_height
            ? { width: row.image_mobile_width, height: row.image_mobile_height }
            : null,
        has_video: row.video_key !== null,
        alt_text: row.alt_text,
        advertises_nicotine: row.advertises_nicotine,
      }));
  }

  /** A showing banner's picture or video, for a shopper. Anything else answers as missing. */
  async shopMedia(shop: ShopClient, id: string, kind: BannerMediaKind, range?: string) {
    const row = await this.db.withOrg(shop.orgId, (tx) => this.rowTx(tx, id).catch(() => null));
    if (!row) throw ApiException.notFound('banner');
    const slugs = await this.db.withOrg(shop.orgId, (tx) => this.categorySlugsTx(tx));
    if (!visibility(row, await this.catalog.purchasable(shop), slugs, new Date()).showing) {
      throw ApiException.notFound('banner');
    }
    return this.read(row, kind, range);
  }

  /** Any banner's picture or video, for the back office's own previews. */
  async staffMedia(orgId: string, id: string, kind: BannerMediaKind, range?: string) {
    const row = await this.db.withOrg(orgId, (tx) => this.rowTx(tx, id));
    return this.read(row, kind, range);
  }

  // ------------------------------------------------------------------ private

  private async read(row: BannerRow, kind: BannerMediaKind, range?: string) {
    const key = kind === 'video' ? row.video_key : kind === 'mobile' ? (row.image_mobile_key ?? row.image_key) : row.image_key;
    if (!key) throw ApiException.notFound('banner media');
    const part = await this.storage.getRange(key, kind === 'video' ? range : undefined);
    return { ...part, contentType: contentTypeFor(key) };
  }

  private checkImage(file: File, what: string) {
    if (file.buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new ApiException(
        'validation_failed',
        `${what} is ${(file.buffer.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024}MB -- resize it first`,
        { retryable: false },
      );
    }
    // Judged by the bytes, not the name or the claimed type.
    const size = imageSize(file.buffer);
    if (!size) {
      throw new ApiException('validation_failed', `${what} isn't a JPEG, PNG or WebP picture`, { retryable: false });
    }
    return size;
  }

  private async checkLinkTx(tx: PoolClient, kind: string, value: string | null) {
    if (kind === 'none' || kind === 'search') return;
    const uuidLike = /^[0-9a-f-]{36}$/i.test(value ?? '');
    const { rows } =
      kind === 'brand'
        ? uuidLike
          ? await tx.query(`SELECT 1 FROM brands WHERE id = $1`, [value])
          : { rows: [] }
        : kind === 'product'
          ? uuidLike
            ? await tx.query(`SELECT 1 FROM products WHERE id = $1`, [value])
            : { rows: [] }
          : await tx.query(`SELECT 1 FROM categories WHERE slug = $1`, [value]);
    if (rows.length === 0) {
      throw new ApiException('validation_failed', `the ${kind} this banner links to doesn't exist`, { retryable: false });
    }
  }

  private async rowTx(tx: PoolClient, id: string): Promise<BannerRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiException.notFound('banner');
    const { rows } = await tx.query<BannerRow>(`SELECT ${COLUMNS} FROM storefront_banners WHERE id = $1`, [id]);
    if (!rows[0]) throw ApiException.notFound('banner');
    return rows[0];
  }

  private async categorySlugsTx(tx: PoolClient): Promise<Map<string, string>> {
    const { rows } = await tx.query<{ slug: string; path: string }>(`SELECT slug, path FROM categories`);
    return new Map(rows.map((row) => [row.slug, row.path]));
  }

  private toView(row: BannerRow, shown: { showing: boolean; reason: string | null }): StorefrontBanner {
    return {
      id: row.id,
      placement: row.placement,
      title: row.title,
      headline: row.headline,
      body: row.body,
      cta_label: row.cta_label,
      link_kind: row.link_kind,
      link_value: row.link_value,
      image: { width: row.image_width, height: row.image_height },
      mobile_image:
        row.image_mobile_width && row.image_mobile_height
          ? { width: row.image_mobile_width, height: row.image_mobile_height }
          : null,
      has_video: row.video_key !== null,
      video_bytes: row.video_bytes === null ? null : Number(row.video_bytes),
      alt_text: row.alt_text,
      advertises_nicotine: row.advertises_nicotine,
      hide_when_unavailable: row.hide_when_unavailable,
      starts_at: row.starts_at?.toISOString() ?? null,
      ends_at: row.ends_at?.toISOString() ?? null,
      sort_order: row.sort_order,
      status: row.status,
      source_note: row.source_note,
      visibility: shown,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

/** Whether a banner shows right now, and the plain reason when it does not. */
export function visibility(
  row: Pick<BannerRow, 'status' | 'starts_at' | 'ends_at' | 'hide_when_unavailable' | 'link_kind' | 'link_value'>,
  targets: PurchasableTargets,
  categoryPaths: Map<string, string>,
  now: Date,
): { showing: boolean; reason: string | null } {
  if (row.status !== 'active') return { showing: false, reason: 'Switched off.' };
  if (row.starts_at && row.starts_at > now) {
    return { showing: false, reason: `Starts ${row.starts_at.toISOString().slice(0, 10)}.` };
  }
  if (row.ends_at && row.ends_at <= now) {
    return { showing: false, reason: `Ended ${row.ends_at.toISOString().slice(0, 10)}.` };
  }
  if (row.hide_when_unavailable && row.link_kind !== 'none' && row.link_value) {
    const value = row.link_value;
    const available =
      row.link_kind === 'brand'
        ? targets.brandIds.has(value)
        : row.link_kind === 'product'
          ? targets.productIds.has(value)
          : row.link_kind === 'category'
            ? (() => {
                const path = categoryPaths.get(value);
                return path !== undefined && targets.categoryPaths.some((p) => isWithin(p, path));
              })()
            : targets.searchable.some((variant) => matches(variant, value));
    if (!available) {
      return { showing: false, reason: 'Hidden: nothing it links to is in stock online right now.' };
    }
  }
  return { showing: true, reason: null };
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.webm')) return 'video/webm';
  return 'image/jpeg';
}
