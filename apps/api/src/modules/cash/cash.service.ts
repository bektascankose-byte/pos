import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

/**
 * Cash drawer sessions.
 *
 * The drawer is the part of a POS an owner checks every single day, and the
 * number they care about is over/short. Getting it right means every movement
 * of cash is a row: the opening float, each cash tender, each refund paid out,
 * paid in, paid out, drops, pickups and the closing count.
 *
 * Expected cash is never stored as a running total that something increments.
 * It is `sum(amount_minor)` over the session's movements, computed when asked.
 * A stored counter drifts the first time a write is retried, and a drawer total
 * that drifts is worse than no drawer total at all, because people trust it.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Open a drawer.
   *
   * A register may have exactly one open session, enforced by a partial unique
   * index. Two open sessions on one drawer would make over/short meaningless,
   * because nobody could say which session a given note belonged to.
   */
  async open(
    orgId: string,
    actorUserId: string,
    input: { register_id: string; opening_float_minor: bigint; blind: boolean; note?: string },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: registerRows } = await tx.query<{ store_id: string }>(
        `SELECT store_id FROM registers WHERE id = $1 AND status = 'active'`,
        [input.register_id],
      );
      const register = registerRows[0];
      if (!register) throw ApiException.notFound('register');

      const { rows: open } = await tx.query<{ id: string }>(
        `SELECT id FROM cash_sessions WHERE register_id = $1 AND closed_at IS NULL`,
        [input.register_id],
      );
      if (open[0]) {
        throw new ApiException('conflict', 'this register already has an open cash session', {
          userMessage: 'The drawer is already open. Close the current session first.',
        });
      }

      const { rows } = await tx.query<{ id: string; opened_at: Date }>(
        `INSERT INTO cash_sessions
           (org_id, store_id, register_id, opened_by, opening_float_minor, blind, note)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6)
         RETURNING id, opened_at`,
        [
          register.store_id,
          input.register_id,
          actorUserId,
          input.opening_float_minor.toString(),
          input.blind,
          input.note ?? null,
        ],
      );
      const session = rows[0]!;

      // The float is a movement like any other, so expected cash is always the
      // sum of movements with no special case for "where did the first $200
      // come from".
      await tx.query(
        `INSERT INTO cash_movements
           (org_id, session_id, kind, amount_minor, actor_user_id, reason)
         VALUES (current_setting('app.org_id')::uuid, $1, 'opening_float', $2, $3, 'session opened')`,
        [session.id, input.opening_float_minor.toString(), actorUserId],
      );

      await this.audit.record(tx, {
        action: 'cash.session_open',
        entityType: 'cash_session',
        entityId: session.id,
        actorUserId,
        storeId: register.store_id,
        registerId: input.register_id,
        newValue: { opening_float_minor: input.opening_float_minor.toString(), blind: input.blind },
      });

      return { id: session.id, opened_at: session.opened_at, blind: input.blind };
    });
  }

  /**
   * Close a drawer against a counted amount.
   *
   * On a blind session the expected total is not returned to the person
   * counting until after they commit their count. That is the whole point: told
   * the expected number first, people type it back, and the count confirms
   * itself rather than the drawer.
   */
  async close(
    orgId: string,
    actorUserId: string,
    sessionId: string,
    input: { counted_minor: bigint; denominations?: Record<string, number>; note?: string },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        store_id: string;
        register_id: string;
        blind: boolean;
        closed_at: Date | null;
      }>(
        `SELECT id, store_id, register_id, blind, closed_at
         FROM cash_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const session = rows[0];
      if (!session) throw ApiException.notFound('cash session');
      if (session.closed_at) {
        throw new ApiException('conflict', 'this session is already closed');
      }

      const expected = await this.expectedCash(tx, sessionId);

      await tx.query(
        `INSERT INTO cash_movements
           (org_id, session_id, kind, amount_minor, actor_user_id, reason)
         VALUES (current_setting('app.org_id')::uuid, $1, 'closing_count', 0, $2, 'session closed')`,
        [sessionId, actorUserId],
      );

      const { rows: closed } = await tx.query<{ variance_minor: string }>(
        `UPDATE cash_sessions
         SET closed_by = $2, closed_at = now(), counted_minor = $3,
             expected_minor = $4, denominations = $5, note = COALESCE($6, note)
         WHERE id = $1
         RETURNING variance_minor::text`,
        [
          sessionId,
          actorUserId,
          input.counted_minor.toString(),
          expected.toString(),
          input.denominations ? JSON.stringify(input.denominations) : null,
          input.note ?? null,
        ],
      );

      const variance = BigInt(closed[0]!.variance_minor);

      await this.audit.record(tx, {
        action: 'cash.session_close',
        entityType: 'cash_session',
        entityId: sessionId,
        actorUserId,
        storeId: session.store_id,
        registerId: session.register_id,
        newValue: {
          counted_minor: input.counted_minor.toString(),
          expected_minor: expected.toString(),
          variance_minor: variance.toString(),
        },
      });

      return {
        id: sessionId,
        counted_minor: input.counted_minor.toString(),
        expected_minor: expected.toString(),
        variance_minor: variance.toString(),
        // Negative is short, positive is over. Named rather than left to the
        // reader, because "-500" on a shift report is ambiguous at a glance.
        outcome: variance === 0n ? 'balanced' : variance < 0n ? 'short' : 'over',
      };
    });
  }

  /** A manual drawer movement: paid in, paid out, drop, pickup, safe deposit. */
  async postMovement(
    orgId: string,
    actorUserId: string,
    input: {
      session_id: string;
      kind: string;
      amount_minor: bigint;
      reason?: string;
      approved_by?: string;
      note?: string;
      occurred_at?: string;
    },
  ) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: sessionRows } = await tx.query<{ store_id: string; closed_at: Date | null }>(
        `SELECT store_id, closed_at FROM cash_sessions WHERE id = $1`,
        [input.session_id],
      );
      const session = sessionRows[0];
      if (!session) throw ApiException.notFound('cash session');
      if (session.closed_at) {
        // Allowing this would change a variance that has already been reported
        // and, in a shop, already been acted on.
        throw new ApiException('conflict', 'this session is closed and cannot take new movements');
      }

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO cash_movements
           (org_id, session_id, kind, amount_minor, reason, actor_user_id, approved_by, note, occurred_at)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))
         RETURNING id`,
        [
          input.session_id,
          input.kind,
          input.amount_minor.toString(),
          input.reason ?? null,
          actorUserId,
          input.approved_by ?? null,
          input.note ?? null,
          input.occurred_at ?? null,
        ],
      );

      await this.audit.record(tx, {
        action: `cash.${input.kind}`,
        entityType: 'cash_movement',
        entityId: rows[0]!.id,
        actorUserId,
        storeId: session.store_id,
        newValue: { amount_minor: input.amount_minor.toString(), reason: input.reason },
        reason: input.reason,
      });

      return { id: rows[0]!.id };
    });
  }

  /**
   * The session as it stands, with expected cash and its breakdown.
   *
   * `expected_minor` is withheld on an open blind session, so the count stays
   * blind right up to the moment it is committed.
   */
  async status(orgId: string, sessionId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        register_id: string;
        blind: boolean;
        opened_at: Date;
        closed_at: Date | null;
        opening_float_minor: string;
        counted_minor: string | null;
        variance_minor: string | null;
      }>(
        `SELECT id, register_id, blind, opened_at, closed_at,
                opening_float_minor::text, counted_minor::text, variance_minor::text
         FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      const session = rows[0];
      if (!session) throw ApiException.notFound('cash session');

      const { rows: breakdown } = await tx.query<{ kind: string; total: string; count: string }>(
        `SELECT kind, sum(amount_minor)::text AS total, count(*)::text AS count
         FROM cash_movements WHERE session_id = $1 GROUP BY kind ORDER BY kind`,
        [sessionId],
      );

      const expected = await this.expectedCash(tx, sessionId);
      const stillBlind = session.blind && !session.closed_at;

      return {
        ...session,
        breakdown,
        expected_minor: stillBlind ? null : expected.toString(),
        blind_pending: stillBlind,
      };
    });
  }

  /** Expected cash: the sum of every movement in the session. */
  private async expectedCash(tx: PoolClient, sessionId: string): Promise<bigint> {
    const { rows } = await tx.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_minor), 0)::text AS total
       FROM cash_movements WHERE session_id = $1`,
      [sessionId],
    );
    return BigInt(rows[0]?.total ?? '0');
  }

  /** The open session for a register, if there is one. The register asks on unlock. */
  async openSessionFor(orgId: string, registerId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, opened_at, opened_by, blind, opening_float_minor::text
         FROM cash_sessions WHERE register_id = $1 AND closed_at IS NULL`,
        [registerId],
      );
      return rows[0] ?? null;
    });
  }
}
