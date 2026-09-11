import { Injectable } from '@nestjs/common';
import type { PostMovement } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { InventoryRepository, type Movement } from './inventory.repository.js';
import { ApiException } from '../../platform/errors/api-exception.js';

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repository: InventoryRepository,
  ) {}

  /**
   * Post one or more movements atomically.
   *
   * All movements in a batch share a transaction, so receiving a purchase order
   * of forty lines either lands completely or not at all. A partially received
   * order is worse than an unreceived one: nobody knows which half is real.
   */
  async postMovements(
    orgId: string,
    actorUserId: string,
    movements: readonly PostMovement[],
    reference?: { type?: string | undefined; id?: string | undefined },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const mapped: Movement[] = movements.map((m) => ({
        storeId: m.store_id,
        variantId: m.variant_id,
        delta: m.delta,
        reason: m.reason,
        unitCost: m.unit_cost,
        referenceType: m.reference_type ?? reference?.type,
        referenceId: m.reference_id ?? reference?.id,
        actorUserId,
        note: m.note,
        // A client supplied idempotency id pins occurred_at as well, so that a
        // replayed post lands on the same ledger partition and conflicts.
        ...(m.idempotency_id
          ? { ledgerId: m.idempotency_id, occurredAt: uuidV7Timestamp(m.idempotency_id) }
          : {}),
      }));

      const levels = await this.repository.post(tx, mapped);
      return { levels };
    });
  }

  async levelsForStore(orgId: string, storeId: string, variantIds?: string[]) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT store_id, variant_id, on_hand::text, reserved::text, available::text, updated_at
         FROM inventory_levels
         WHERE store_id = $1
           AND ($2::uuid[] IS NULL OR variant_id = ANY($2::uuid[]))
         ORDER BY variant_id`,
        [storeId, variantIds?.length ? variantIds : null],
      );
      return rows;
    });
  }

  async ledger(
    orgId: string,
    filter: {
      storeId?: string | undefined;
      variantId?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, store_id, variant_id, occurred_at, delta::text, reason,
                unit_cost::text, reference_type, reference_id, actor_user_id, note
         FROM inventory_ledger
         WHERE ($1::uuid IS NULL OR store_id = $1)
           AND ($2::uuid IS NULL OR variant_id = $2)
           AND ($3::timestamptz IS NULL OR occurred_at < $3)
         ORDER BY occurred_at DESC
         LIMIT $4`,
        [filter.storeId ?? null, filter.variantId ?? null, filter.cursor ?? null, filter.limit],
      );
      return rows;
    });
  }

  /** Nightly job: prove the projection still equals the ledger. */
  async reconcile(orgId: string, storeId?: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const drift = await this.repository.reconcile(tx, storeId);
      const negative = await this.repository.negativeStock(tx);
      return { drift, negative, healthy: drift.length === 0 };
    });
  }
}

/**
 * Recover the millisecond timestamp a UUIDv7 encodes in its first 48 bits.
 *
 * This is what lets a register generated id pin its own ledger partition: the
 * id and the timestamp derived from it are both deterministic, so a replay
 * lands on exactly the same primary key and conflicts instead of double
 * counting. Deriving the time from the id rather than trusting a separate field
 * also means a register with a skewed clock cannot send an id and a timestamp
 * that disagree.
 */
function uuidV7Timestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  const ms = Number.parseInt(hex, 16);
  if (!Number.isFinite(ms)) {
    throw new ApiException('validation_failed', `"${id}" is not a decodable UUIDv7`);
  }
  return new Date(ms);
}
