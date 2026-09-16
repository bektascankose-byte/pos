import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ObjectStorageService } from '../../platform/storage/object-storage.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

/** What a browser may send. Deliberately narrow: these are photographs, not a general file drop. */
const ALLOWED = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

/**
 * A hard ceiling, not a sizing policy. The dashboard downscales before it
 * uploads, so anything arriving near this is a client that didn't -- and a
 * register syncing a hundred 8-megapixel photos over a shop's DSL is a real
 * way to make the till feel broken.
 */
const MAX_BYTES = 6 * 1024 * 1024;

const IMAGE_COLUMNS = `id, product_id, variant_id, alt_text, sort_order,
       (sort_order = (SELECT min(i2.sort_order) FROM product_images i2
                       WHERE i2.product_id IS NOT DISTINCT FROM product_images.product_id
                         AND i2.variant_id IS NOT DISTINCT FROM product_images.variant_id))
         AS is_primary,
       created_at`;

/**
 * Photographs of things the shop sells.
 *
 * The bytes live in object storage and only a key is kept in the row, which is
 * the same split `invoice_imports` already uses. The key is never handed to a
 * client: images come back through an endpoint that authenticates the caller,
 * because the bucket is private and a presigned URL would expire out from
 * under a register that has been offline since Tuesday.
 *
 * Nothing here resizes anything. The dashboard sends an already-downscaled
 * display image and a thumbnail, which keeps an image-processing library out
 * of a service whose job is selling cigarettes -- and means the one place that
 * decides how big a product photo should be is the one place that knows how
 * big it will be drawn.
 */
@Injectable()
export class ProductImagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorageService,
  ) {}

  async listForProduct(orgId: string, productId: string) {
    return this.db.withOrg(orgId, (tx) => this.listForProductTx(tx, productId));
  }

  /**
   * Every image for a product, including those attached to its variants --
   * the product page shows them together, and a variant photo is still a
   * photo of this product.
   */
  async listForProductTx(tx: PoolClient, productId: string) {
    const { rows } = await tx.query(
      `SELECT ${IMAGE_COLUMNS} FROM product_images
       WHERE product_id = $1
          OR variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)
       ORDER BY sort_order, created_at`,
      [productId],
    );
    return rows;
  }

  /**
   * Store an image and record it.
   *
   * `thumb` is optional and separate rather than derived, because the caller
   * is the only party that knows whether it has one. A row with no thumbnail
   * simply serves the full image where a thumbnail was wanted, which is slower
   * but never wrong.
   */
  async upload(
    orgId: string,
    actorUserId: string,
    input: { product_id?: string | undefined; variant_id?: string | undefined; alt_text?: string | undefined },
    file: { buffer: Buffer; contentType: string },
    thumb?: { buffer: Buffer; contentType: string } | undefined,
  ) {
    const extension = ALLOWED.get(file.contentType);
    if (!extension) {
      throw new ApiException(
        'validation_failed',
        `"${file.contentType}" isn't an image this accepts -- send a JPEG, PNG or WebP`,
        { retryable: false },
      );
    }
    if (file.buffer.byteLength > MAX_BYTES) {
      throw new ApiException(
        'validation_failed',
        `that image is ${(file.buffer.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_BYTES / 1024 / 1024}MB`,
        { retryable: false },
      );
    }
    // Exactly one owner. The table's own CHECK only requires at least one, so
    // the "not both" half is enforced here: an image that claims to belong to
    // a product AND one of its variants would appear twice on the page and be
    // ambiguous to every reader after that.
    if (!input.product_id === !input.variant_id) {
      throw new ApiException(
        'validation_failed',
        'an image belongs either to a product or to one of its variants, not both and not neither',
        { retryable: false },
      );
    }

    return this.db.withOrg(orgId, async (tx) => {
      // Proves the target exists *and* belongs to this org before anything is
      // written to storage, so a bad id cannot leave an orphaned object behind.
      const productId = await this.resolveProductId(tx, input);

      const id = randomUUID();
      const key = `products/${productId}/${id}.${extension}`;
      await this.storage.put(key, file.buffer, file.contentType);

      let thumbKey: string | null = null;
      if (thumb) {
        const thumbExtension = ALLOWED.get(thumb.contentType);
        if (thumbExtension) {
          thumbKey = `products/${productId}/${id}-thumb.${thumbExtension}`;
          await this.storage.put(thumbKey, thumb.buffer, thumb.contentType);
        }
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO product_images
           (id, org_id, product_id, variant_id, url, thumb_url, alt_text, sort_order)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6,
                 COALESCE((SELECT max(sort_order) + 1 FROM product_images
                           WHERE product_id IS NOT DISTINCT FROM $2
                             AND variant_id IS NOT DISTINCT FROM $3), 0))
         RETURNING id`,
        [id, input.product_id ?? null, input.variant_id ?? null, key, thumbKey, input.alt_text ?? null],
      );

      await this.audit.record(tx, {
        action: 'catalog.image.upload',
        entityType: 'product_image',
        entityId: rows[0]!.id,
        actorUserId,
        newValue: {
          product_id: input.product_id ?? null,
          variant_id: input.variant_id ?? null,
          bytes: file.buffer.byteLength,
        },
      });

      return { images: await this.listForProductTx(tx, productId) };
    });
  }

  /**
   * The bytes, for the endpoint that streams them.
   *
   * Reading the row first is what makes this safe: the key comes from a table
   * guarded by row-level security, so a caller can only ever name an image
   * their own organization owns. Taking a storage key from the request instead
   * would be a path traversal into somebody else's bucket prefix.
   */
  async read(orgId: string, id: string, variant: 'full' | 'thumb') {
    const row = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ url: string; thumb_url: string | null }>(
        `SELECT url, thumb_url FROM product_images WHERE id = $1`,
        [id],
      );
      return rows[0];
    });
    if (!row) throw ApiException.notFound('image');

    // Falling back to the full image is deliberate: a missing thumbnail should
    // cost bandwidth, not show a broken picture.
    const key = variant === 'thumb' ? (row.thumb_url ?? row.url) : row.url;
    const body = await this.storage.get(key);
    return { body, contentType: contentTypeFor(key) };
  }

  async remove(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ product_id: string | null; variant_id: string | null }>(
        `DELETE FROM product_images WHERE id = $1 RETURNING product_id, variant_id`,
        [id],
      );
      const removed = rows[0];
      if (!removed) throw ApiException.notFound('image');

      // The object itself is left in the bucket. Deleting it would make this
      // irreversible for the sake of a few kilobytes, and an orphan costs
      // nothing but storage -- whereas a row deleted by mistake with its bytes
      // already gone cannot be put back.
      await this.audit.record(tx, {
        action: 'catalog.image.remove',
        entityType: 'product_image',
        entityId: id,
        actorUserId,
        oldValue: { product_id: removed.product_id, variant_id: removed.variant_id },
      });

      const productId = await this.resolveProductId(tx, {
        ...(removed.product_id ? { product_id: removed.product_id } : {}),
        ...(removed.variant_id ? { variant_id: removed.variant_id } : {}),
      });
      return { images: await this.listForProductTx(tx, productId) };
    });
  }

  /** Reordering is how the primary image is chosen: first in the list wins. */
  async reorder(orgId: string, actorUserId: string, imageIds: string[]) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; product_id: string | null; variant_id: string | null }>(
        `SELECT id, product_id, variant_id FROM product_images WHERE id = ANY($1::uuid[])`,
        [imageIds],
      );
      if (rows.length !== imageIds.length) {
        throw ApiException.notFound('image');
      }

      for (const [index, imageId] of imageIds.entries()) {
        await tx.query(`UPDATE product_images SET sort_order = $2 WHERE id = $1`, [imageId, index]);
      }

      await this.audit.record(tx, {
        action: 'catalog.image.reorder',
        entityType: 'product_image',
        entityId: imageIds[0]!,
        actorUserId,
        newValue: { order: imageIds },
      });

      const first = rows[0]!;
      const productId = await this.resolveProductId(tx, {
        ...(first.product_id ? { product_id: first.product_id } : {}),
        ...(first.variant_id ? { variant_id: first.variant_id } : {}),
      });
      return { images: await this.listForProductTx(tx, productId) };
    });
  }

  /** Which product a photo ultimately belongs to, whichever end it was attached by. */
  private async resolveProductId(
    tx: PoolClient,
    input: { product_id?: string | undefined; variant_id?: string | undefined },
  ): Promise<string> {
    if (input.product_id) {
      const { rows } = await tx.query<{ id: string }>(`SELECT id FROM products WHERE id = $1`, [
        input.product_id,
      ]);
      if (!rows[0]) throw ApiException.notFound('product');
      return rows[0].id;
    }

    const { rows } = await tx.query<{ product_id: string }>(
      `SELECT product_id FROM product_variants WHERE id = $1`,
      [input.variant_id],
    );
    if (!rows[0]) throw ApiException.notFound('variant');
    return rows[0].product_id;
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
