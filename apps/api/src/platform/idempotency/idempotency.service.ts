import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { ApiException } from '../errors/api-exception.js';

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency for writes that move money or stock.
 *
 * The register retries aggressively by design: it has no idea whether a request
 * that timed out was applied, and the only safe assumption is that it might
 * have been. So every such request carries a key, and a replay returns the
 * original response rather than doing the work twice.
 *
 * Three cases, and the third is the one most implementations get wrong:
 *
 *   same key, same body      replay. Return the stored response.
 *   same key, different body 409. This is a client bug - two different requests
 *                            reusing one key - and treating it as a replay
 *                            would silently drop the second one.
 *   same key, still running  409 retryable. Two deliveries of the same request
 *                            arrived close enough to overlap. The unique index
 *                            makes one of them lose the race rather than both
 *                            executing.
 *
 * The `in_flight` state is what makes the third case safe. Without it, two
 * concurrent deliveries both find no record and both proceed, which is exactly
 * the double-charge this whole mechanism exists to prevent.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Stable hash of the request body, so key reuse with different content is caught. */
  fingerprint(body: unknown): string {
    return createHash('sha256').update(canonicalize(body)).digest('hex');
  }

  async execute<T>(
    orgId: string,
    key: string,
    endpoint: string,
    body: unknown,
    work: (tx: PoolClient) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentOutcome<T>> {
    const requestHash = this.fingerprint(body);

    const claim = await this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        state: string;
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        `INSERT INTO idempotency_keys (org_id, key, endpoint, request_hash, state)
         VALUES ($1,$2,$3,$4,'in_flight')
         ON CONFLICT (org_id, key) DO NOTHING
         RETURNING state, request_hash, response_status, response_body`,
        [orgId, key, endpoint, requestHash],
      );

      // Insert won: we own this key and may do the work.
      if (rows[0]) return { owned: true as const };

      const { rows: existing } = await tx.query<{
        state: string;
        request_hash: string;
        endpoint: string;
        response_status: number | null;
        response_body: T | null;
      }>(
        `SELECT state, request_hash, endpoint, response_status, response_body
         FROM idempotency_keys WHERE org_id = $1 AND key = $2`,
        [orgId, key],
      );
      return { owned: false as const, record: existing[0] };
    });

    if (claim.owned) {
      try {
        const result = await this.db.withOrg(orgId, (tx) => work(tx));
        await this.complete(orgId, key, result.status, result.body);
        return { ...result, replayed: false };
      } catch (error) {
        // Release the key so a legitimate retry can succeed. Keeping it would
        // make a transient database blip permanently un-retryable, which for a
        // sale upload means a lost sale.
        await this.release(orgId, key);
        throw error;
      }
    }

    const record = claim.record;
    if (!record) {
      throw new ApiException('conflict', 'idempotency record vanished mid request', {
        retryable: true,
      });
    }

    if (record.request_hash !== requestHash) {
      throw new ApiException(
        'idempotency_key_reuse',
        `idempotency key "${key}" was already used for a different request body`,
        {
          userMessage: 'This action was already submitted with different details.',
          retryable: false,
        },
      );
    }

    if (record.state === 'in_flight') {
      throw new ApiException('conflict', 'an identical request is still being processed', {
        retryable: true,
      });
    }

    return {
      status: record.response_status ?? 200,
      body: record.response_body as T,
      replayed: true,
    };
  }

  private async complete(orgId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `UPDATE idempotency_keys
         SET state = 'completed', response_status = $3, response_body = $4, completed_at = now()
         WHERE org_id = $1 AND key = $2`,
        [orgId, key, status, JSON.stringify(body ?? null)],
      );
    });
  }

  private async release(orgId: string, key: string): Promise<void> {
    try {
      await this.db.withOrg(orgId, async (tx) => {
        await tx.query(`DELETE FROM idempotency_keys WHERE org_id = $1 AND key = $2 AND state = 'in_flight'`, [
          orgId,
          key,
        ]);
      });
    } catch (error) {
      this.logger.error({ key, err: (error as Error).message }, 'could not release idempotency key');
    }
  }
}

/**
 * Canonical JSON: keys sorted recursively so that two bodies differing only in
 * property order hash identically. Without this a client that serializes its
 * JSON in a different order on retry would be told its key was reused.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}
