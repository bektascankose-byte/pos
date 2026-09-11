import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { InventoryReason } from '@snappos/contracts';
import { ApiException } from '../../platform/errors/api-exception.js';

export interface Movement {
  storeId: string;
  variantId: string;
  /** Signed. Never zero; the database rejects that and so do the contracts. */
  delta: string;
  reason: InventoryReason;
  unitCost?: string | undefined;
  referenceType?: string | undefined;
  referenceId?: string | undefined;
  actorUserId?: string | undefined;
  deviceId?: string | undefined;
  note?: string | undefined;
  /**
   * Deterministic ledger id. When supplied, replaying the same movement is a
   * no-op rather than a second deduction. This is the property that makes an
   * aggressive sync retry safe, and it is enforced by a unique primary key
   * rather than by anyone remembering to check first.
   *
   * MUST be accompanied by `occurredAt`. The ledger is partitioned by month, so
   * its primary key is (id, occurred_at) rather than id alone - a partitioned
   * table's key has to include the partition column. A replay that reuses the
   * id but lets occurred_at default to now() therefore does NOT conflict, and
   * inserts a second row. The timestamp has to come from the source document
   * (a sale's completed_at, a receipt's posted_at) so it is identical on every
   * delivery. `post()` refuses the combination that would silently double count.
   */
  ledgerId?: string | undefined;
  /** Deterministic movement time. Required whenever `ledgerId` is set. */
  occurredAt?: Date | string | undefined;
}

export interface LevelSnapshot {
  storeId: string;
  variantId: string;
  onHand: string;
  reserved: string;
  available: string;
}

/**
 * The only code in this system permitted to change stock.
 *
 * Architecture section F: the ledger is the truth and `inventory_levels` is a
 * projection of it. Both are written in one transaction, through here, always.
 * A nightly job recomputes `sum(delta)` per store and variant and reports drift,
 * and in practice drift only ever appears when something has bypassed this
 * class - which is precisely what the job is for.
 *
 * Two asymmetries that look like bugs and are not:
 *
 *   on_hand MAY go negative. Two registers offline at once can both sell the
 *   last unit. Both sales are facts; the customers already left with the
 *   product. Refusing the second record would not un-sell it, it would only
 *   hide the discrepancy. It goes to -1 and raises an alert with both sale ids.
 *
 *   reserved may NOT go negative. A reservation is created by this system, so a
 *   negative one is always a bug in this system, never a fact about a shelf.
 */
@Injectable()
export class InventoryRepository {
  private readonly logger = new Logger(InventoryRepository.name);

  /**
   * Post movements and update levels in one transaction.
   *
   * The caller supplies the transaction, so a sale writes its lines, payments
   * and stock movements atomically. Stock must never be deducted by a sale that
   * then fails to commit.
   */
  async post(tx: PoolClient, movements: readonly Movement[]): Promise<LevelSnapshot[]> {
    if (movements.length === 0) return [];

    const touched = new Map<string, { storeId: string; variantId: string }>();

    for (const m of movements) {
      if (isZero(m.delta)) {
        throw new ApiException('validation_failed', 'a zero stock movement records nothing');
      }

      // Without a stable occurred_at the ON CONFLICT target cannot match on a
      // replay, so the id would provide no protection at all while appearing to.
      if (m.ledgerId && !m.occurredAt) {
        throw new ApiException(
          'validation_failed',
          'a movement with a deterministic ledgerId must also supply occurredAt; ' +
            'the ledger primary key is (id, occurred_at) because the table is partitioned by month',
        );
      }

      const inserted = await this.insertLedgerEntry(tx, m);

      // Zero rows means this exact ledger id already existed, so the level was
      // already adjusted for it. Applying the delta again is precisely the
      // double count this design exists to prevent.
      if (!inserted) {
        this.logger.debug({ ledgerId: m.ledgerId }, 'ledger entry already applied, skipping');
        continue;
      }

      await this.applyToLevel(tx, m);
      touched.set(`${m.storeId}:${m.variantId}`, { storeId: m.storeId, variantId: m.variantId });
    }

    return this.readLevels(tx, [...touched.values()]);
  }

  private async insertLedgerEntry(tx: PoolClient, m: Movement): Promise<boolean> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO inventory_ledger
         (id, org_id, store_id, variant_id, delta, reason, unit_cost,
          reference_type, reference_id, actor_user_id, device_id, note, occurred_at)
       VALUES (COALESCE($1::uuid, uuid_generate_v7()),
               current_setting('app.org_id')::uuid,
               $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               COALESCE($12::timestamptz, now()))
       ON CONFLICT (id, occurred_at) DO NOTHING
       RETURNING id`,
      [
        m.ledgerId ?? null,
        m.storeId,
        m.variantId,
        m.delta,
        m.reason,
        m.unitCost ?? null,
        m.referenceType ?? null,
        m.referenceId ?? null,
        m.actorUserId ?? null,
        m.deviceId ?? null,
        m.note ?? null,
        m.occurredAt ?? null,
      ],
    );
    return rows.length > 0;
  }

  private async applyToLevel(tx: PoolClient, m: Movement): Promise<void> {
    await tx.query(
      `INSERT INTO inventory_levels (org_id, store_id, variant_id, on_hand, reserved)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, 0)
       ON CONFLICT (store_id, variant_id)
       DO UPDATE SET on_hand = inventory_levels.on_hand + EXCLUDED.on_hand,
                     updated_at = now()`,
      [m.storeId, m.variantId, m.delta],
    );
  }

  private async readLevels(
    tx: PoolClient,
    keys: readonly { storeId: string; variantId: string }[],
  ): Promise<LevelSnapshot[]> {
    if (keys.length === 0) return [];
    const { rows } = await tx.query<{
      store_id: string;
      variant_id: string;
      on_hand: string;
      reserved: string;
      available: string;
    }>(
      `SELECT store_id, variant_id, on_hand::text, reserved::text, available::text
       FROM inventory_levels
       WHERE (store_id, variant_id) IN (
         SELECT * FROM unnest($1::uuid[], $2::uuid[])
       )`,
      [keys.map((k) => k.storeId), keys.map((k) => k.variantId)],
    );
    return rows.map((r) => ({
      storeId: r.store_id,
      variantId: r.variant_id,
      onHand: r.on_hand,
      reserved: r.reserved,
      available: r.available,
    }));
  }

  /**
   * Recompute levels from the ledger and report disagreement.
   *
   * Run nightly. This is the check that proves the projection still matches the
   * truth, and the only honest way to know that nothing has bypassed this class.
   */
  async reconcile(
    tx: PoolClient,
    storeId?: string,
  ): Promise<{ storeId: string; variantId: string; level: string; ledger: string }[]> {
    const { rows } = await tx.query<{
      store_id: string;
      variant_id: string;
      level: string;
      ledger: string;
    }>(
      `SELECT l.store_id, l.variant_id,
              l.on_hand::text                        AS level,
              COALESCE(sum(g.delta), 0)::text        AS ledger
       FROM inventory_levels l
       LEFT JOIN inventory_ledger g
              ON g.store_id = l.store_id AND g.variant_id = l.variant_id
       WHERE ($1::uuid IS NULL OR l.store_id = $1)
       GROUP BY l.store_id, l.variant_id, l.on_hand
       HAVING l.on_hand <> COALESCE(sum(g.delta), 0)`,
      [storeId ?? null],
    );

    if (rows.length > 0) {
      this.logger.error(
        { count: rows.length },
        'inventory drift: a level disagrees with its ledger, so something wrote stock outside the repository',
      );
    }

    return rows.map((r) => ({
      storeId: r.store_id,
      variantId: r.variant_id,
      level: r.level,
      ledger: r.ledger,
    }));
  }

  /** Levels that went negative. Expected after concurrent offline sales; always worth surfacing. */
  async negativeStock(tx: PoolClient): Promise<LevelSnapshot[]> {
    const { rows } = await tx.query<{
      store_id: string;
      variant_id: string;
      on_hand: string;
      reserved: string;
      available: string;
    }>(
      `SELECT store_id, variant_id, on_hand::text, reserved::text, available::text
       FROM inventory_levels WHERE on_hand < 0`,
    );
    return rows.map((r) => ({
      storeId: r.store_id,
      variantId: r.variant_id,
      onHand: r.on_hand,
      reserved: r.reserved,
      available: r.available,
    }));
  }
}

function isZero(delta: string): boolean {
  return /^-?0(\.0+)?$/.test(delta.trim());
}
