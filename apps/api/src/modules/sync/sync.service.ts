import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SyncBatch, SyncResult, Change } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';

const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Accept an upload batch from a register.
   *
   * Ordered but not atomic, on purpose. Entity 7 failing validation must not
   * block entities 1 to 6: one malformed row cannot be allowed to hold a day of
   * sales hostage. Each entity gets its own transaction and its own verdict.
   *
   * A duplicate is a success. That is the whole design: the register retries
   * without knowing whether the previous attempt landed, and `ON CONFLICT DO
   * NOTHING` intake makes a second delivery insert nothing and report
   * `duplicate`. The register treats that identically to `accepted` and clears
   * its outbox row.
   */
  async ingest(orgId: string, batch: SyncBatch, receivedAt: Date) {
    const results: SyncResult[] = [];

    for (const envelope of batch.entities) {
      try {
        const status = await this.db.withOrg(orgId, (tx) =>
          this.ingestOne(tx, orgId, batch, envelope),
        );
        results.push({ id: envelope.id, status });
      } catch (error) {
        const message = (error as Error).message;
        const retryable = this.isRetryable(error);

        if (!retryable && envelope.attempt >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
          // A visible, inspectable state. Never a silent hole in the day's
          // numbers: the register shows Sync Error and a manager can act.
          await this.deadLetter(orgId, batch, envelope, message);
        }

        this.logger.warn(
          { entityId: envelope.id, type: envelope.entity_type, attempt: envelope.attempt },
          `sync entity rejected: ${message}`,
        );

        results.push({
          id: envelope.id,
          status: 'rejected',
          error: { code: retryable ? 'internal_error' : 'validation_failed', message, retryable },
        });
      }
    }

    // The register stores this offset and reports use server time, so a
    // register with a wrong clock cannot reorder the day's sales.
    const deviceTime = batch.entities[0]?.device_time;
    const clockOffsetMs = deviceTime
      ? receivedAt.getTime() - new Date(deviceTime).getTime()
      : 0;

    await this.recordDeviceContact(orgId, batch.device_id, clockOffsetMs);

    return {
      results,
      server_time: receivedAt.toISOString(),
      clock_offset_ms: clockOffsetMs,
    };
  }

  /**
   * Phase 1 handles inventory movements. Sales, refunds, payments and cash
   * sessions land in Phase 2 with the register itself; the envelope, the
   * idempotency guarantee and the dead letter path are all in place for them.
   */
  private async ingestOne(
    tx: PoolClient,
    orgId: string,
    batch: SyncBatch,
    envelope: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    switch (envelope.entity_type) {
      case 'inventory_movement':
        return this.ingestMovement(tx, envelope);
      default:
        throw new Error(
          `entity type "${envelope.entity_type}" is not accepted yet (Phase 2)`,
        );
    }
  }

  private async ingestMovement(
    tx: PoolClient,
    envelope: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    const p = envelope.payload as {
      store_id: string;
      variant_id: string;
      delta: string;
      reason: string;
      unit_cost?: string;
      note?: string;
    };

    // occurred_at is derived from the envelope id, not from a separate field,
    // so the (id, occurred_at) primary key is identical on every delivery and a
    // replay conflicts instead of inserting a second movement.
    const occurredAt = uuidV7Timestamp(envelope.id);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inventory_ledger
         (id, occurred_at, org_id, store_id, variant_id, delta, reason, unit_cost,
          reference_type, reference_id, note)
       VALUES ($1,$2,current_setting('app.org_id')::uuid,$3,$4,$5,$6,$7,'sync',$1,$8)
       ON CONFLICT (id, occurred_at) DO NOTHING
       RETURNING id`,
      [
        envelope.id,
        occurredAt,
        p.store_id,
        p.variant_id,
        p.delta,
        p.reason,
        p.unit_cost ?? null,
        p.note ?? null,
      ],
    );

    // Zero rows means it was already applied. Do NOT touch the level: the
    // projection was updated the first time, and applying the delta again is
    // exactly the double count the deterministic id exists to prevent.
    if (rows.length === 0) return 'duplicate';

    await tx.query(
      `INSERT INTO inventory_levels (org_id, store_id, variant_id, on_hand, reserved)
       VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,0)
       ON CONFLICT (store_id, variant_id)
       DO UPDATE SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand, updated_at = now()`,
      [p.store_id, p.variant_id, p.delta],
    );

    return 'accepted';
  }

  /**
   * Downstream changes since a cursor.
   *
   * The cursor is `change_log.id`, a bigserial, and the query is bounded by the
   * transaction watermark rather than by `max(id)`.
   *
   * The reason is subtle and costs a day of sales when missed: a bigserial value
   * is allocated before its transaction commits, so a row with id 500 can become
   * visible AFTER a row with id 501. A reader that consumes everything up to
   * max(id) advances its cursor past 500 while 500 is still invisible, and then
   * never sees it. The watermark function in packages/db holds the cursor below
   * any id that might still be in flight.
   */
  async changes(
    orgId: string,
    params: {
      since: string;
      limit: number;
      storeId?: string | undefined;
      scopes?: string[] | undefined;
    },
  ): Promise<{ changes: Change[]; next_cursor: string; has_more: boolean; server_time: string }> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        entity_type: string;
        entity_id: string;
        op: string;
        payload_hash: string | null;
      }>(
        // <= rather than <: the watermark function already returns the last id
        // that is safe to hand out (min in-flight id minus one).
        `SELECT id::text, entity_type, entity_id, op, payload_hash
         FROM change_log
         WHERE id > $1::bigint
           AND id <= sync_changes_watermark()
           AND ($2::uuid IS NULL OR store_id IS NULL OR store_id = $2)
           AND ($3::text[] IS NULL OR $3::text[] @> ARRAY[entity_type])
         ORDER BY id
         LIMIT $4`,
        [
          params.since,
          params.storeId ?? null,
          params.scopes?.length ? expandScopes(params.scopes) : null,
          params.limit,
        ],
      );

      const changes = rows.map((r) => ({
        id: r.id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        op: r.op as Change['op'],
        scope: scopeFor(r.entity_type),
        payload_hash: r.payload_hash,
      }));

      return {
        changes,
        // Never advance past the last row actually returned. An empty page
        // leaves the cursor where it was rather than jumping to the watermark,
        // so a row committing late is still picked up.
        next_cursor: changes.at(-1)?.id ?? params.since,
        has_more: changes.length === params.limit,
        server_time: new Date().toISOString(),
      };
    });
  }

  private async deadLetter(
    orgId: string,
    batch: SyncBatch,
    envelope: SyncBatch['entities'][number],
    reason: string,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO sync_dead_letter
           (org_id, device_id, entity_type, entity_id, payload, error, attempts)
         VALUES (current_setting('app.org_id')::uuid,$1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [
          batch.device_id,
          envelope.entity_type,
          envelope.id,
          JSON.stringify(envelope.payload),
          reason,
          envelope.attempt,
        ],
      );
    });
  }

  private async recordDeviceContact(
    orgId: string,
    deviceId: string,
    clockOffsetMs: number,
  ): Promise<void> {
    try {
      await this.db.withOrg(orgId, async (tx) => {
        await tx.query(
          `UPDATE devices SET last_seen_at = now(), clock_offset_ms = $2 WHERE id = $1`,
          [deviceId, clockOffsetMs],
        );
      });
    } catch (error) {
      // Bookkeeping. A failure here must never fail an upload that contains
      // completed sales.
      this.logger.warn({ deviceId, err: (error as Error).message }, 'could not record device contact');
    }
  }

  /** Retryable means transient. An inaccurate answer either loses a sale or retries forever. */
  private isRetryable(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    if (!code) return false;
    // Serialization failure, deadlock, too many connections, admin shutdown.
    return ['40001', '40P01', '53300', '57P01', '08006', '08003'].includes(code);
  }
}

function uuidV7Timestamp(id: string): Date {
  return new Date(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16));
}

/**
 * Which sync scope an entity belongs to.
 *
 * change_log records entity_type; the register subscribes by scope. Mapping
 * here rather than storing a scope column keeps the write path on the hot
 * counter path as cheap as possible, and lets the grouping change without a
 * backfill of a table that grows by every catalog edit.
 */
const SCOPE_BY_ENTITY: Record<string, Change['scope']> = {
  product: 'catalog',
  product_variant: 'catalog',
  variant_barcode: 'catalog',
  category: 'catalog',
  brand: 'catalog',
  variant_price: 'prices',
  promotion: 'promotions',
  compliance_rule: 'compliance',
  product_compliance: 'compliance',
  tax_rate: 'tax',
  tax_category: 'tax',
  user: 'employees',
  employee_pin: 'employees',
  role: 'employees',
  register: 'register_config',
  store: 'register_config',
  customer: 'customers',
};

function scopeFor(entityType: string): Change['scope'] {
  return SCOPE_BY_ENTITY[entityType] ?? 'catalog';
}

function expandScopes(scopes: string[]): string[] {
  const wanted = new Set(scopes);
  return Object.entries(SCOPE_BY_ENTITY)
    .filter(([, scope]) => wanted.has(scope))
    .map(([entityType]) => entityType);
}
