import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { saleInput, refundInput, cashMovementInput } from '@snappos/contracts';
import type { SyncBatch, SyncResult, Change } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { SalesService } from '../sales/sales.service.js';
import { RefundsService } from '../refunds/refunds.service.js';

const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 5;

/**
 * The permission each entity type actually requires.
 *
 * `sync.upload` only says "this device may talk to the sync endpoint". Without
 * this table it would also mean "and may therefore push anything at all", which
 * would let a cashier who cannot issue a refund over HTTP issue one by putting
 * it in a sync batch instead. The permission that governs an action has to
 * govern it on every route that can perform it, or it governs nothing.
 */
const PERMISSION_BY_ENTITY: Record<string, string> = {
  sale: 'sale.create',
  refund: 'refund.create',
  cash_movement: 'cash.paid_in_out',
  cash_session: 'cash.session_open',
  inventory_movement: 'inventory.adjust',
  age_verification: 'sale.create',
  time_entry: 'employee.timeclock_edit',
};

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesService,
    private readonly refunds: RefundsService,
  ) {}

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
  async ingest(
    orgId: string,
    batch: SyncBatch,
    receivedAt: Date,
    permissions: readonly string[] = [],
  ) {
    const results: SyncResult[] = [];
    const held = new Set(permissions);

    for (const envelope of batch.entities) {
      try {
        const required = PERMISSION_BY_ENTITY[envelope.entity_type];
        if (required && !held.has(required)) {
          // Rejected per entity rather than failing the batch: a cashier's
          // sales must still upload even if a refund in the same batch is
          // refused. Not retryable - permissions will not change on retry.
          throw new PermissionError(
            `uploading a ${envelope.entity_type} requires ${required}`,
          );
        }

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
          error: {
            code:
              error instanceof PermissionError
                ? 'forbidden'
                : retryable
                  ? 'internal_error'
                  : 'validation_failed',
            message,
            retryable,
          },
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
   * Route one envelope to the service that owns its entity type.
   *
   * Each arrives already validated by its own schema rather than trusted: a
   * register running a build from three months ago is a normal situation in
   * retail, not an edge case, and its payload has to be checked the same way a
   * direct HTTP body is.
   */
  private async ingestOne(
    tx: PoolClient,
    orgId: string,
    batch: SyncBatch,
    envelope: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    switch (envelope.entity_type) {
      case 'sale': {
        const sale = saleInput.parse({ ...envelope.payload, id: envelope.id });
        return this.sales.intake(tx, sale, batch.device_id);
      }
      case 'refund': {
        const refund = refundInput.parse({ ...envelope.payload, id: envelope.id });
        return this.refunds.intake(tx, refund, batch.device_id);
      }
      case 'cash_movement': {
        const movement = cashMovementInput.parse({ ...envelope.payload, id: envelope.id });
        return this.ingestCashMovement(tx, movement, batch.device_id);
      }
      case 'inventory_movement':
        return this.ingestMovement(tx, envelope);
      case 'payment':
        // Payments arrive inside their sale or refund envelope, never alone. A
        // standalone payment would be money with nothing to attach it to.
        throw new Error('payments are uploaded inside their sale or refund, not separately');
      default:
        throw new Error(`entity type "${envelope.entity_type}" is not accepted yet`);
    }
  }

  private async ingestCashMovement(
    tx: PoolClient,
    movement: { id: string; session_id: string; kind: string; amount_minor: bigint;
               reason?: string | undefined; reference_type?: string | undefined;
               reference_id?: string | undefined; actor_user_id: string;
               approved_by?: string | undefined; occurred_at: string; note?: string | undefined },
    deviceId: string,
  ): Promise<'accepted' | 'duplicate'> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cash_movements
         (id, org_id, session_id, kind, amount_minor, reason, reference_type, reference_id,
          actor_user_id, approved_by, occurred_at, device_id, note)
       VALUES ($1, current_setting('app.org_id')::uuid, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        movement.id,
        movement.session_id,
        movement.kind,
        movement.amount_minor.toString(),
        movement.reason ?? null,
        movement.reference_type ?? null,
        movement.reference_id ?? null,
        movement.actor_user_id,
        movement.approved_by ?? null,
        movement.occurred_at,
        deviceId,
        movement.note ?? null,
      ],
    );
    return rows.length === 0 ? 'duplicate' : 'accepted';
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

/** A permission failure inside a batch, so it can be reported as `forbidden`. */
class PermissionError extends Error {
  override name = 'PermissionError';
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
