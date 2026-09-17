import { createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { ShopClient } from '../../platform/shop/shop-key.registry.js';

export const CUSTOMER_SESSION_HEADER = 'x-customer-session';

const SESSION_DAYS = 30;
const SEEN_EVERY_MS = 5 * 60_000;

export interface CustomerSession {
  sessionId: string;
  customerId: string;
}

/** The session token a request presented, if any. Checked by `CustomerSessions`, not here. */
export const CustomerToken = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<FastifyRequest>().headers[CUSTOMER_SESSION_HEADER];
  return typeof value === 'string' ? value : undefined;
});

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Signed-in shoppers.
 *
 * Separate from staff sign-in on purpose, and not a JWT. The staff guard
 * accepts any token it can verify on every route that does not name a
 * permission, so a customer token signed with the same key would have walked
 * straight into parts of the back office. These tokens are random, stored
 * hashed, checked against the database on every request and carried in a
 * header the staff guard never reads -- so a customer session can do exactly
 * what the shop routes let it do, and nothing else.
 */
@Injectable()
export class CustomerSessions {
  constructor(private readonly db: DatabaseService) {}

  async createTx(tx: PoolClient, customerId: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await tx.query<{ expires_at: Date }>(
      `INSERT INTO customer_sessions (org_id, customer_id, token_hash, expires_at)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, now() + make_interval(days => $3))
       RETURNING expires_at`,
      [customerId, hashSecret(token), SESSION_DAYS],
    );
    return { token, expiresAt: rows[0]!.expires_at.toISOString() };
  }

  /** The signed-in customer, or null for a guest or a session that has ended. */
  async resolve(shop: ShopClient, token: string | undefined): Promise<CustomerSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;

    return this.db.withOrg(shop.orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string; customer_id: string; last_seen_at: Date }>(
        `SELECT s.id, s.customer_id, s.last_seen_at
         FROM customer_sessions s
         JOIN customers c ON c.id = s.customer_id
         WHERE s.token_hash = $1
           AND s.revoked_at IS NULL
           AND s.expires_at > now()
           AND c.status = 'active'
           AND c.anonymized_at IS NULL`,
        [hashSecret(token)],
      );
      const row = rows[0];
      if (!row) return null;

      if (Date.now() - row.last_seen_at.getTime() > SEEN_EVERY_MS) {
        await tx.query(`UPDATE customer_sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
      }
      return { sessionId: row.id, customerId: row.customer_id };
    });
  }

  async require(shop: ShopClient, token: string | undefined): Promise<CustomerSession> {
    const session = await this.resolve(shop, token);
    if (!session) throw new ApiException('unauthenticated', 'sign in to continue');
    return session;
  }

  async revoke(shop: ShopClient, token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.withOrg(shop.orgId, (tx) =>
      tx.query(`UPDATE customer_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
        hashSecret(token),
      ]),
    );
  }

  /** End every session a customer has, except optionally the one they are using. */
  async revokeAllTx(tx: PoolClient, customerId: string, exceptSessionId?: string): Promise<void> {
    await tx.query(
      `UPDATE customer_sessions SET revoked_at = now()
       WHERE customer_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid`,
      [customerId, exceptSessionId ?? null],
    );
  }
}
