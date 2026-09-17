import { Injectable } from '@nestjs/common';
import type { CreatedStorefrontClient, StorefrontClient } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { mintShopKey, ShopKeyRegistry } from '../../platform/shop/shop-key.registry.js';

const COLUMNS = `id, name, store_id, key_prefix, created_at, last_used_at, revoked_at`;

/**
 * The keys a storefront server presents to the API.
 *
 * A key is shown once, when it is created, and never again: only its hash is
 * kept. Losing one means revoking it and issuing another, which is the same
 * thing that should happen when one leaks -- and so it is the only thing this
 * offers. There is no "show key" and no "rotate in place".
 */
@Injectable()
export class StorefrontClientsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly keys: ShopKeyRegistry,
  ) {}

  async list(orgId: string): Promise<StorefrontClient[]> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<StorefrontClient>(
        `SELECT ${COLUMNS} FROM storefront_clients ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      );
      return rows;
    });
  }

  async create(orgId: string, actorUserId: string, storeId: string, name: string): Promise<CreatedStorefrontClient> {
    const minted = mintShopKey();
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<StorefrontClient>(
        `INSERT INTO storefront_clients (org_id, store_id, name, key_hash, key_prefix, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [storeId, name, minted.hash, minted.prefix, actorUserId],
      );
      const client = rows[0]!;
      await this.audit.record(tx, {
        action: 'storefront.key.created',
        entityType: 'storefront_client',
        entityId: client.id,
        actorUserId,
        storeId,
        newValue: { name, key_prefix: minted.prefix },
      });
      return { client, key: minted.key };
    });
  }

  async revoke(orgId: string, actorUserId: string, id: string): Promise<StorefrontClient> {
    const client = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<StorefrontClient>(
        `UPDATE storefront_clients SET revoked_at = COALESCE(revoked_at, now())
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (!row) throw ApiException.notFound('storefront key');
      await this.audit.record(tx, {
        action: 'storefront.key.revoked',
        entityType: 'storefront_client',
        entityId: id,
        actorUserId,
        storeId: row.store_id,
        newValue: { key_prefix: row.key_prefix },
      });
      return row;
    });
    // Stop honouring it here at once, rather than when this instance's cache
    // happens to expire. Other instances notice within a minute.
    this.keys.forget();
    return client;
  }
}
