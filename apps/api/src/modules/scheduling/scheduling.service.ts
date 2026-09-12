import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ShiftQuery, CreateShift, UpdateShift } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const SHIFT_COLUMNS = `s.id, s.store_id, s.user_id, u.full_name AS employee_name,
       s.starts_at, s.ends_at, s.status, s.note, s.created_at`;

@Injectable()
export class SchedulingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Every scheduled shift overlapping the range at all, not just ones fully inside it -- a shift spanning midnight or the window edge must still show up. */
  async list(orgId: string, query: ShiftQuery) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${SHIFT_COLUMNS}
         FROM shifts s
         JOIN users u ON u.id = s.user_id
         WHERE s.status = 'scheduled'
           AND s.starts_at < $2
           AND s.ends_at > $1
           AND ($3::uuid IS NULL OR s.store_id = $3)
           AND ($4::uuid IS NULL OR s.user_id = $4)
         ORDER BY s.starts_at`,
        [query.from, query.to, query.store_id ?? null, query.user_id ?? null],
      );
      return rows;
    });
  }

  async create(orgId: string, actorUserId: string, input: CreateShift) {
    return this.db.withOrg(orgId, async (tx) => {
      await this.assertNoOverlap(tx, input.user_id, input.starts_at, input.ends_at);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO shifts (org_id, store_id, user_id, starts_at, ends_at, note, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [input.store_id, input.user_id, input.starts_at, input.ends_at, input.note ?? null, actorUserId],
      );
      const id = rows[0]!.id;

      await this.audit.record(tx, {
        action: 'schedule.create',
        entityType: 'shift',
        entityId: id,
        actorUserId,
        newValue: { user_id: input.user_id, starts_at: input.starts_at, ends_at: input.ends_at },
      });

      return this.getOne(tx, id);
    });
  }

  /** Time and note only -- moving a shift to a different employee or store is a cancel-and-recreate, not an edit. */
  async update(orgId: string, actorUserId: string, id: string, input: UpdateShift) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: existingRows } = await tx.query<{
        user_id: string;
        starts_at: string;
        ends_at: string;
      }>(`SELECT user_id, starts_at, ends_at FROM shifts WHERE id = $1`, [id]);
      const existing = existingRows[0];
      if (!existing) throw ApiException.notFound('shift');

      if (input.starts_at || input.ends_at) {
        await this.assertNoOverlap(
          tx,
          existing.user_id,
          input.starts_at ?? existing.starts_at,
          input.ends_at ?? existing.ends_at,
          id,
        );
      }

      await tx.query(
        `UPDATE shifts SET
           starts_at = COALESCE($2::timestamptz, starts_at),
           ends_at   = COALESCE($3::timestamptz, ends_at),
           note      = COALESCE($4, note)
         WHERE id = $1`,
        [id, input.starts_at ?? null, input.ends_at ?? null, input.note ?? null],
      );

      await this.audit.record(tx, {
        action: 'schedule.update',
        entityType: 'shift',
        entityId: id,
        actorUserId,
        newValue: input,
      });

      return this.getOne(tx, id);
    });
  }

  async cancel(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE shifts SET status = 'cancelled' WHERE id = $1 AND status = 'scheduled' RETURNING id`,
        [id],
      );
      if (!rows[0]) throw ApiException.notFound('shift');

      await this.audit.record(tx, {
        action: 'schedule.cancel',
        entityType: 'shift',
        entityId: id,
        actorUserId,
        newValue: {},
      });

      return { ok: true };
    });
  }

  private async assertNoOverlap(
    tx: PoolClient,
    userId: string,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
  ): Promise<void> {
    const { rows } = await tx.query(
      `SELECT id FROM shifts
       WHERE user_id = $1 AND status = 'scheduled'
         AND starts_at < $3 AND ends_at > $2
         AND ($4::uuid IS NULL OR id != $4)
       LIMIT 1`,
      [userId, startsAt, endsAt, excludeId ?? null],
    );
    if (rows.length > 0) {
      throw new ApiException('conflict', 'this employee already has an overlapping shift', {
        retryable: false,
      });
    }
  }

  private async getOne(tx: PoolClient, id: string) {
    const { rows } = await tx.query(
      `SELECT ${SHIFT_COLUMNS} FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [id],
    );
    return rows[0];
  }
}
