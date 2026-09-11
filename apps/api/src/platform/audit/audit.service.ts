import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

export interface AuditEntry {
  action: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  actorType?: 'user' | 'system' | 'device' | undefined;
  storeId?: string | undefined;
  registerId?: string | undefined;
  deviceId?: string | undefined;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | undefined;
  ip?: string | undefined;
  requestId?: string | undefined;
}

/**
 * The audit log.
 *
 * Every entry is written **inside the caller's transaction**. A void that
 * commits without its audit row, or an audit row for a void that rolled back,
 * are both worse than useless in a loss prevention investigation: one hides
 * what happened and the other invents something that did not. Sharing the
 * transaction is what makes the log and the fact it describes inseparable.
 *
 * `seq`, `prev_hash` and `hash` are deliberately left NULL here. The chain is
 * sealed asynchronously by a single serialized worker, because hashing in a
 * trigger cannot order concurrent inserts without taking a lock that would slow
 * down checkout — and nothing is allowed to slow down checkout. An unsealed row
 * is still a complete record; the chain only adds proof that nobody edited it
 * afterwards.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Record inside an existing transaction. The preferred form. */
  async record(tx: PoolClient, entry: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log
         (org_id, actor_user_id, actor_type, device_id, store_id, register_id,
          action, entity_type, entity_id, old_value, new_value, reason, ip, request_id)
       VALUES (current_setting('app.org_id')::uuid,
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entry.actorUserId ?? null,
        entry.actorType ?? 'user',
        entry.deviceId ?? null,
        entry.storeId ?? null,
        entry.registerId ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
        entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
        entry.reason ?? null,
        entry.ip ?? null,
        entry.requestId ?? null,
      ],
    );
  }

  /**
   * Record in its own transaction, for events with no surrounding write — a
   * failed login, an export, a permission denial.
   *
   * Failure is logged and swallowed. These are observations about something
   * that already happened; failing the user's request because the observation
   * could not be stored would turn a logging problem into an outage.
   */
  async recordStandalone(orgId: string, entry: AuditEntry): Promise<void> {
    try {
      await this.db.withOrg(orgId, (tx) => this.record(tx, entry));
    } catch (error) {
      this.logger.error(
        { action: entry.action, err: (error as Error).message },
        'could not write audit entry',
      );
    }
  }

  async query(
    orgId: string,
    filter: {
      entityType?: string | undefined;
      entityId?: string | undefined;
      actorUserId?: string | undefined;
      action?: string | undefined;
      storeId?: string | undefined;
      limit: number;
    },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, occurred_at, actor_user_id, actor_type, store_id, register_id,
                action, entity_type, entity_id, old_value, new_value, reason
         FROM audit_log
         WHERE ($1::text IS NULL OR entity_type = $1)
           AND ($2::uuid IS NULL OR entity_id = $2)
           AND ($3::uuid IS NULL OR actor_user_id = $3)
           AND ($4::text IS NULL OR action = $4)
           AND ($5::uuid IS NULL OR store_id = $5)
         ORDER BY occurred_at DESC
         LIMIT $6`,
        [
          filter.entityType ?? null,
          filter.entityId ?? null,
          filter.actorUserId ?? null,
          filter.action ?? null,
          filter.storeId ?? null,
          filter.limit,
        ],
      );
      return { data: rows, next_cursor: null };
    });
  }
}
