import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';

/** The shop a storefront request is for, resolved from its key. */
export interface ShopClient {
  clientId: string;
  orgId: string;
  storeId: string;
}

/** A key is only ever compared as a hash; the key itself is never stored. */
export function hashShopKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * A new key, and what to store for it.
 *
 * The prefix makes a key recognisable in a secret scanner and in a config file;
 * the random part is 32 bytes, which nobody is guessing.
 */
export function mintShopKey(): { key: string; hash: string; prefix: string } {
  const key = `shop_live_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashShopKey(key), prefix: key.slice(0, 14) };
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const TOUCH_EVERY_MS = 5 * 60_000;

/**
 * Which shop a storefront key belongs to.
 *
 * Every shopper request carries the key, so resolving it from the database
 * each time would put a query in front of every page view. A minute's cache is
 * the trade: a revoked key keeps working for up to a minute on another API
 * instance, and immediately on the one that revoked it, which calls `forget`.
 *
 * `peek` exists for the rate limiter, which runs before any guard and cannot
 * wait on the database. A key it has not seen yet is simply limited by address
 * like any other caller until the first request resolves it.
 */
@Injectable()
export class ShopKeyRegistry {
  private readonly logger = new Logger(ShopKeyRegistry.name);
  private readonly cache = new Map<string, { client: ShopClient | null; expires: number }>();
  private readonly touched = new Map<string, number>();

  constructor(private readonly db: DatabaseService) {}

  async resolve(key: string): Promise<ShopClient | null> {
    const hash = hashShopKey(key);
    const cached = this.cache.get(hash);
    if (cached && cached.expires > Date.now()) return cached.client;

    const client = await this.db.unscoped(async (connection) => {
      const { rows } = await connection.query<{ client_id: string; org_id: string; store_id: string }>(
        `SELECT client_id, org_id, store_id FROM shop_lookup_client($1)`,
        [hash],
      );
      const row = rows[0];
      return row ? { clientId: row.client_id, orgId: row.org_id, storeId: row.store_id } : null;
    });

    this.cache.set(hash, {
      client,
      expires: Date.now() + (client ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    if (client) this.touch(client);
    return client;
  }

  /** What the cache already knows, without waiting. For the rate limiter only. */
  peek(key: string): ShopClient | null {
    const cached = this.cache.get(hashShopKey(key));
    return cached && cached.expires > Date.now() ? cached.client : null;
  }

  /** Drop everything cached, so a key revoked here stops working here at once. */
  forget(): void {
    this.cache.clear();
  }

  /**
   * Record that a key is in use, at most every few minutes. Enough for a
   * person looking at the key list to tell a live key from a forgotten one,
   * without an update on every page view.
   */
  private touch(client: ShopClient): void {
    const last = this.touched.get(client.clientId) ?? 0;
    if (Date.now() - last < TOUCH_EVERY_MS) return;
    this.touched.set(client.clientId, Date.now());

    this.db
      .withOrg(client.orgId, (tx) =>
        tx.query(`UPDATE storefront_clients SET last_used_at = now() WHERE id = $1`, [client.clientId]),
      )
      .catch((error: unknown) => {
        // Bookkeeping, never worth failing a shopper's request over.
        this.logger.warn({ clientId: client.clientId, error: (error as Error).message }, 'could not record key use');
      });
  }
}
