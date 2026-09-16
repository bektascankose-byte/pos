import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  saleInput,
  refundInput,
  saleVoidInput,
  cashMovementInput,
  syncEnvelopeSchema,
} from '@snappos/contracts';
import type { SyncBatch, SyncResult, Change } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { RetryableIntakeError } from '../../platform/errors/retryable-intake.js';
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
  sale_void: 'sale.void',
  refund: 'refund.create',
  cash_movement: 'cash.paid_in_out',
  cash_session: 'cash.session_open',
  cash_session_close: 'cash.session_close',
  inventory_movement: 'inventory.adjust',
  age_verification: 'sale.create',
  time_entry: 'employee.timeclock_edit',
};

/**
 * The payload field naming who authorized an action, where that is someone
 * other than whoever is uploading.
 *
 * A register's connection identity is transport, not authority. The cashier
 * signed in at the counter cannot issue a refund, and should not be able to -
 * but a manager standing next to them can, by PIN, on a register with no
 * network. When that refund finally uploads it is still the cashier's token
 * carrying it, and checking the token's permissions would reject a refund that
 * was properly approved hours earlier.
 *
 * So for these entity types the permission is checked against the user the
 * payload names. The device's claim is not taken on faith: the named user is
 * looked up here and must actually hold the permission. A register that lied
 * about who approved a refund gets the same rejection as one that had nobody
 * approve it at all.
 */
const APPROVER_FIELD_BY_ENTITY: Record<string, string> = {
  refund: 'approved_by',
  sale_void: 'approved_by',
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
        // Rejected per entity rather than failing the batch: a cashier's
        // sales must still upload even if a refund in the same batch is
        // refused. Not retryable - permissions will not change on retry.
        await this.assertPermitted(orgId, envelope, held);

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
  /**
   * Decide whether this envelope may be accepted, and by whose authority.
   *
   * Two cases. Ordinary entities are governed by the uploading token. Entities
   * that name an approver are governed by that approver, looked up live, which
   * is what lets a manager-approved refund taken offline upload later under a
   * cashier's token without giving the cashier the ability to refund on their
   * own.
   */
  private async assertPermitted(
    orgId: string,
    envelope: SyncBatch['entities'][number],
    held: ReadonlySet<string>,
  ): Promise<void> {
    const required = PERMISSION_BY_ENTITY[envelope.entity_type];
    if (!required) return;

    const approverField = APPROVER_FIELD_BY_ENTITY[envelope.entity_type];
    if (!approverField) {
      if (!held.has(required)) {
        throw new PermissionError(
          `uploading a ${envelope.entity_type} requires ${required}`,
        );
      }
      return;
    }

    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const approverId = payload[approverField];

    if (typeof approverId !== 'string' || approverId.length === 0) {
      // No named approver, so the only authority left is the uploader's own.
      // A cashier's unapproved refund lands here and is refused, which is the
      // entire point of requiring an approval at the counter.
      if (!held.has(required)) {
        throw new PermissionError(
          `a ${envelope.entity_type} must name the user who approved it in ` +
            `${approverField}, or be uploaded by someone holding ${required}`,
        );
      }
      return;
    }

    const approverHolds = await this.db.withOrg(orgId, (tx) =>
      this.userHolds(tx, approverId, required),
    );

    if (!approverHolds) {
      throw new PermissionError(
        `the user named in ${approverField} does not hold ${required}`,
      );
    }
  }

  /**
   * Whether a user holds a permission, right now.
   *
   * Scoped by org through RLS, so a register cannot name a manager belonging to
   * a different organization. An inactive user holds nothing: revoking someone
   * has to take effect on the sync path too, or a stolen device keeps their
   * authority indefinitely.
   */
  private async userHolds(
    tx: PoolClient,
    userId: string,
    permission: string,
  ): Promise<boolean> {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT true AS ok
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN users u ON u.id = ur.user_id AND u.org_id = ur.org_id
        WHERE ur.user_id = $1
          AND rp.permission_key = $2
          AND u.status = 'active'
        LIMIT 1`,
      [userId, permission],
    );
    return rows.length > 0;
  }

  private async ingestOne(
    tx: PoolClient,
    orgId: string,
    batch: SyncBatch,
    raw: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    // Strict validation happens here, per entity, inside the try/catch that
    // produces a per-entity verdict. Doing it at the batch level would make one
    // malformed row reject every sale behind it.
    const envelope = syncEnvelopeSchema.parse(raw);

    switch (envelope.entity_type) {
      case 'sale': {
        const sale = saleInput.parse({ ...envelope.payload, id: envelope.id });
        return this.sales.intake(tx, sale, batch.device_id);
      }
      case 'sale_void': {
        const voidInput = saleVoidInput.parse({ ...envelope.payload, id: envelope.id });
        return this.sales.intakeVoid(tx, voidInput);
      }
      case 'refund': {
        const refund = refundInput.parse({ ...envelope.payload, id: envelope.id });
        return this.refunds.intake(tx, refund, batch.device_id);
      }
      case 'cash_session': {
        return this.ingestCashSession(tx, envelope);
      }
      case 'cash_session_close': {
        return this.ingestCashSessionClose(tx, envelope);
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

  /**
   * A drawer opened on a register.
   *
   * The id was minted on the device, so a replayed upload conflicts rather than
   * opening a second session. That matters more here than almost anywhere: two
   * sessions on one drawer would make over/short meaningless, because nobody
   * could say which session a given note belonged to.
   */
  private async ingestCashSession(
    tx: PoolClient,
    envelope: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    const p = envelope.payload as {
      store_id: string;
      register_id: string;
      opened_by: string;
      opening_float_minor: string;
      blind: boolean;
      opened_at: string;
    };

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO cash_sessions
         (id, org_id, store_id, register_id, opened_by, opened_at, opening_float_minor, blind)
       VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        envelope.id,
        p.store_id,
        p.register_id,
        p.opened_by,
        p.opened_at,
        p.opening_float_minor,
        p.blind,
      ],
    );

    if (rows.length === 0) return 'duplicate';

    // The opening float is a movement like any other, so expected cash stays
    // "the sum of the movements" with no special case anywhere downstream.
    await tx.query(
      `INSERT INTO cash_movements
         (org_id, session_id, kind, amount_minor, reason, actor_user_id, occurred_at)
       VALUES (current_setting('app.org_id')::uuid, $1, 'opening_float', $2, 'session opened', $3, $4)`,
      [envelope.id, p.opening_float_minor, p.opened_by, p.opened_at],
    );

    return 'accepted';
  }

  /**
   * A drawer closed against a counted amount.
   *
   * Expected cash is recomputed here from the movements the server actually
   * holds, rather than trusting the figure the device sent. The two normally
   * agree; when they do not, the server's is the one that reconciles with the
   * sales it has, and a difference is worth seeing rather than papering over.
   */
  private async ingestCashSessionClose(
    tx: PoolClient,
    envelope: SyncBatch['entities'][number],
  ): Promise<'accepted' | 'duplicate'> {
    const p = envelope.payload as {
      session_id: string;
      closed_by: string;
      counted_minor: string;
      closed_at: string;
      note?: string;
    };

    const { rows: existing } = await tx.query<{ closed_at: Date | null }>(
      `SELECT closed_at FROM cash_sessions WHERE id = $1 FOR UPDATE`,
      [p.session_id],
    );
    if (!existing[0]) throw new Error(`cash session ${p.session_id} is not on the server yet`);
    if (existing[0].closed_at) return 'duplicate';

    const { rows: expectedRows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_minor), 0)::text AS total
       FROM cash_movements WHERE session_id = $1`,
      [p.session_id],
    );
    const expected = expectedRows[0]?.total ?? '0';

    await tx.query(
      `INSERT INTO cash_movements
         (org_id, session_id, kind, amount_minor, reason, actor_user_id, occurred_at)
       VALUES (current_setting('app.org_id')::uuid, $1, 'closing_count', 0, 'session closed', $2, $3)`,
      [p.session_id, p.closed_by, p.closed_at],
    );

    await tx.query(
      `UPDATE cash_sessions
       SET closed_by = $2, closed_at = $3, counted_minor = $4, expected_minor = $5,
           note = COALESCE($6, note)
       WHERE id = $1`,
      [p.session_id, p.closed_by, p.closed_at, p.counted_minor, expected, p.note ?? null],
    );

    return 'accepted';
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
        // ORDER BY is qualified on purpose. `SELECT id::text` produces an
        // output column also called `id`, and a bare `ORDER BY id` binds to the
        // output column ahead of the table's — sorting the cursor as *text*.
        // That gives 1, 10, 11, ... 2, 20, so `LIMIT` returns an arbitrary
        // subset and a register paging with `since` skips changes permanently:
        // a price change or a new product no till ever hears about, with
        // nothing reporting a fault. `change_log.id` cannot match an output
        // alias, so it sorts the bigint.
        `SELECT id::text, entity_type, entity_id, op, payload_hash
         FROM change_log
         WHERE id > $1::bigint
           AND id <= sync_changes_watermark()
           AND ($2::uuid IS NULL OR store_id IS NULL OR store_id = $2)
           AND ($3::text[] IS NULL OR $3::text[] @> ARRAY[entity_type])
         ORDER BY change_log.id
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

  /**
   * The catalog a register replicates, as one snapshot.
   *
   * A register needs everything it can sell before it can sell anything, and
   * `/sync/changes` cannot provide that: it is a log of what changed, so a
   * device with an empty database has nothing to apply changes to. This is the
   * bootstrap, and the change feed carries it forward from there.
   *
   * Deliberately scoped to one store. A register has no business holding
   * another store's prices, and on a device that can be stolen the smallest
   * useful copy is the right one.
   *
   * Customers are NOT included, on purpose. Caching the customer table on a
   * terminal is a privacy problem with no operational payoff: the register
   * looks a customer up by phone number when it needs one.
   */
  async catalogSnapshot(orgId: string, storeId: string, since?: string) {
    return this.db.withOrg(orgId, async (tx) => {
      // The store has to exist in this org before anything is read. RLS already
      // makes another org's store invisible, but invisible here means every
      // store scoped query returns nothing - and an empty snapshot delivered
      // with a 200 is indistinguishable from a store that has no staff, no
      // prices and no stock. A register that asked for the wrong store must be
      // told so, not handed a catalog it cannot open the till with.
      const { rows: storeRows } = await tx.query<{ id: string }>(
        `SELECT id FROM stores WHERE id = $1`,
        [storeId],
      );
      if (storeRows.length === 0) {
        throw new NotFoundException('no such store in this organization');
      }

      // Detect and read in this same transaction. A separate changes request
      // followed by a scoped snapshot can advance past a different scope that
      // commits between the two calls, making that change invisible forever.
      const { rows: watermarkRows } = await tx.query<{ cursor: string }>(
        `SELECT COALESCE(sync_changes_watermark(), 0)::text AS cursor`,
      );
      const watermark = watermarkRows[0]?.cursor ?? '0';
      let includedScopes = ['catalog', 'prices', 'tax', 'employees', 'inventory'];
      // A cursor ahead of this database means the server was restored/reset.
      // Treat it as bootstrap; moving the cursor backwards while returning no
      // rows would leave stale device data claiming to be current.
      if (since !== undefined && BigInt(since) <= BigInt(watermark)) {
        const { rows: changedRows } = await tx.query<{ entity_type: string }>(
          `SELECT DISTINCT entity_type FROM change_log
           WHERE id > $1::bigint AND id <= $2::bigint
             AND (store_id IS NULL OR store_id = $3)`,
          [since, watermark, storeId],
        );
        const scopes = new Set(changedRows.map((row) => scopeFor(row.entity_type)));
        // Compliance is embedded in the variant projection. Register/store
        // configuration is rare and safest as a complete refresh.
        if (scopes.has('register_config')) {
          includedScopes = ['catalog', 'prices', 'tax', 'employees', 'inventory'];
        } else {
          includedScopes = [];
          if (scopes.has('catalog') || scopes.has('compliance')) includedScopes.push('catalog');
          if (scopes.has('prices')) includedScopes.push('prices');
          if (scopes.has('tax')) includedScopes.push('tax');
          if (scopes.has('employees')) includedScopes.push('employees');
        }
      }
      const includes = (scope: string) => includedScopes.includes(scope);
      const empty = Promise.resolve({ rows: [] as any[] });

      const [{ rows: categories }, { rows: variants }, { rows: barcodes }, { rows: prices },
             { rows: levels }, { rows: taxRates }] = await Promise.all([
        includes('catalog') ? tx.query(
          `SELECT id, parent_id, slug, name, path, depth, sort_order, tile_color,
                  is_department
           FROM categories WHERE status = 'active' ORDER BY path`,
        ) : empty,
        includes('catalog') ? tx.query(
          `SELECT v.id, v.product_id, p.name AS product_name, v.variant_name, v.sku, v.plu,
                  p.brand_id, b.name AS brand_name, p.category_id, p.tax_category_id,
                  v.cost::text, v.case_quantity, v.sort_order, v.is_default, v.status,
                  pc.minimum_age, COALESCE(pc.id_scan_required, false) AS id_scan_required,
                  pc.regulated_class,
                  -- A path, not the bytes. The register fetches the image
                  -- itself and keeps it: an image's address never changes
                  -- meaning -- replacing a photo makes a new row with a new
                  -- id -- so whatever a register has already downloaded stays
                  -- valid forever, and the snapshot stays small enough to sync
                  -- over a shop's uplink.
                  img.path AS image_url
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           LEFT JOIN brands b ON b.id = p.brand_id
           LEFT JOIN product_compliance pc ON pc.product_id = p.id
           -- The variant's own photo wins; failing that the product's, which is
           -- the right picture for a flavour nobody photographed separately.
           LEFT JOIN LATERAL (
             SELECT '/api/v1/catalog/images/' || i.id || '?size=thumb' AS path
             FROM product_images i
             WHERE i.variant_id = v.id OR i.product_id = p.id
             ORDER BY (i.variant_id IS NULL), i.sort_order, i.created_at
             LIMIT 1
           ) img ON true
           WHERE v.status = 'active' AND p.status = 'active'`,
        ) : empty,
        includes('catalog') ? tx.query(
          `SELECT vb.id, vb.variant_id, vb.barcode, vb.kind, vb.units::text, vb.is_primary
           FROM variant_barcodes vb
           JOIN product_variants v ON v.id = vb.variant_id
           WHERE v.status = 'active'`,
        ) : empty,
        // Store specific prices win over the organization default, and both are
        // sent: a price scheduled for Monday has to be on the register on
        // Sunday night, because the register may be offline on Monday.
        includes('prices') ? tx.query(
          `SELECT id, variant_id, kind, price_minor::text,
                  effective_from, effective_to
           FROM variant_prices
           WHERE (store_id = $1 OR store_id IS NULL)
             AND (effective_to IS NULL OR effective_to > now())`,
          [storeId],
        ) : empty,
        includes('inventory') ? tx.query(
          `SELECT variant_id, on_hand::text, available::text, updated_at
           FROM inventory_levels WHERE store_id = $1`,
          [storeId],
        ) : empty,
        includes('tax') ? tx.query(
          `SELECT tax_category_id, rate::text, name
           FROM tax_rates
           WHERE (store_id = $1 OR store_id IS NULL)
             AND effective_from <= now()
             AND (effective_to IS NULL OR effective_to > now())`,
          [storeId],
        ) : empty,
      ]);

      // Employees who may unlock this register.
      //
      // The PIN hash is replicated so unlock works with no network, which is the
      // whole point: a register is most likely to be offline exactly when a
      // shift starts. Three things make that acceptable:
      //
      //   * only this store's staff, never the whole organization
      //   * the PIN hash only. The password hash is NOT sent, because a
      //     password unlocks the dashboard and everything in it, and a stolen
      //     terminal must not carry one
      //   * it lands in a SQLCipher database keyed from the Android Keystore
      //
      // A four digit PIN is 10,000 combinations, so the hash was never what
      // protected it. Lockout is, and the register counts failures locally
      // because that is where the attempts happen.
      const { rows: employees } = includes('employees') ? await tx.query(
        `SELECT DISTINCT u.id, COALESCE(u.display_name, u.full_name) AS display_name,
                u.employee_code, p.pin_hash, u.status,
                COALESCE(
                  (SELECT array_agg(DISTINCT rp.permission_key)
                   FROM user_roles ur2
                   JOIN role_permissions rp ON rp.role_id = ur2.role_id
                   WHERE ur2.user_id = u.id),
                  '{}'
                ) AS permissions
         FROM users u
         JOIN employee_pins p ON p.user_id = u.id
         JOIN user_roles ur ON ur.user_id = u.id
         WHERE u.status = 'active'
           AND (ur.store_id = $1 OR ur.store_id IS NULL)`,
        [storeId],
      ) : { rows: [] };

      // The cursor the register resumes the change feed from. Taken AFTER the
      // snapshot reads so nothing committed during them is missed; re-applying
      // a change already in the snapshot is harmless, skipping one is not.
      return {
        categories,
        variants,
        barcodes,
        prices,
        inventory: levels,
        tax_rates: taxRates,
        employees,
        included_scopes: includedScopes,
        cursor: watermark,
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
    // Some intake failures are transient for a reason the database cannot
    // express — a void whose sale has not been delivered yet is the first.
    if (error instanceof RetryableIntakeError) return true;

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
