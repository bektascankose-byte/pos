import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service.js';

export interface OutboxEvent {
  /** Dotted and past tense: `order.placed`, `delivery.status_changed`. An event is something that happened, never an instruction. */
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown> | undefined;
  /** The request that caused this. Carried through so one order is traceable across every system it touches. */
  correlationId?: string | undefined;
  /** Which store this concerns, when it concerns one. */
  storeId?: string | undefined;
  /** Publish no earlier than this. Used by retries; almost never by callers. */
  availableAt?: Date | undefined;
}

/**
 * How long a claimed event stays out of sight while its handler runs.
 *
 * Long enough that no reasonable handler is still working when it expires --
 * an event that reappears mid-handler gets delivered twice. Short enough that
 * a process killed mid-delivery does not strand its events for long.
 */
const VISIBILITY_SECONDS = Number(process.env.OUTBOX_VISIBILITY_SECONDS ?? 60);

export interface ClaimedEvent {
  id: string;
  orgId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  attempts: number;
}

/**
 * The transactional outbox.
 *
 * `emit` writes **inside the caller's transaction**, for the same reason
 * `AuditService.record` does and with the same consequence if it didn't: an
 * order that commits without its event never reaches the register, and an
 * event for an order that rolled back summons a cashier to a sale that does
 * not exist. Sharing the transaction is what makes the fact and the
 * announcement of it inseparable.
 *
 * Delivery is somebody else's problem -- `OutboxPump`'s -- and deliberately
 * so. The network is allowed to be down for an hour without any of the above
 * being at risk, because nothing here waits on it.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly db: DatabaseService) {}

  /** Emit inside an existing transaction. The only form callers should use. */
  async emit(tx: PoolClient, event: OutboxEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events
         (org_id, store_id, event_type, aggregate_type, aggregate_id, payload,
          correlation_id, available_at)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5::jsonb, $6,
               COALESCE($7::timestamptz, now()))`,
      [
        event.storeId ?? null,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload ?? {}),
        event.correlationId ?? null,
        event.availableAt ?? null,
      ],
    );
  }

  /**
   * Take up to `limit` events that are due, locking them against other pumps.
   *
   * Two mechanisms, and both are load-bearing:
   *
   * `FOR UPDATE SKIP LOCKED` stops two pumps claiming the same row in the same
   * instant -- one wins, the other steps over it rather than waiting.
   *
   * The **visibility timeout** stops them claiming it in different instants.
   * That row lock lives only as long as the UPDATE, so without pushing
   * `available_at` into the future a second pump ticking while the first is
   * still inside a slow handler would find the event pending, due, and claim
   * it again -- delivering it twice. Moving it out of sight for
   * `VISIBILITY_SECONDS` gives the handler room to finish, and returns the
   * event to the queue by itself if the process handling it dies.
   *
   * Attempts is incremented here rather than on failure, so an event that
   * kills the process still counts its try and cannot spin forever.
   *
   * Runs unscoped: the pump serves every organization, so it cannot set one
   * org's id the way a request-scoped call does.
   */
  async claim(limit: number): Promise<ClaimedEvent[]> {
    const { rows } = await this.db.unscoped((c) => c.query<{
      id: string;
      org_id: string;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      correlation_id: string | null;
      attempts: number;
    }>(
      `UPDATE outbox_events
          SET attempts = attempts + 1,
              available_at = now() + make_interval(secs => $2)
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE published_at IS NULL AND dead_at IS NULL AND available_at <= now()
         ORDER BY available_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, org_id, event_type, aggregate_type, aggregate_id,
                 payload, correlation_id, attempts`,
      [limit, VISIBILITY_SECONDS],
    ));

    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      correlationId: row.correlation_id,
      attempts: row.attempts,
    }));
  }

  async markDelivered(id: string): Promise<void> {
    await this.db.unscoped((c) =>
      c.query(
        `UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = $1`,
        [id],
      ),
    );
  }

  /**
   * Record a failure and schedule the retry, or give up.
   *
   * Giving up is a real state rather than an infinite retry: an event whose
   * handler is broken would otherwise be attempted forever, burying the
   * events behind it and telling nobody. `dead` is visible, alertable, and
   * replayable once whatever broke is fixed.
   */
  async markFailed(id: string, attempts: number, error: string, maxAttempts: number): Promise<void> {
    if (attempts >= maxAttempts) {
      await this.db.unscoped((c) =>
        c.query(`UPDATE outbox_events SET dead_at = now(), last_error = $2 WHERE id = $1`, [
          id,
          truncate(error),
        ]),
      );
      return;
    }

    await this.db.unscoped((c) =>
      c.query(
        `UPDATE outbox_events
           SET available_at = now() + make_interval(secs => $2), last_error = $3
         WHERE id = $1`,
        [id, backoffSeconds(attempts), truncate(error)],
      ),
    );
  }

  /** Put a dead event back in the queue, once whatever broke has been fixed. */
  async replay(orgId: string, id: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE outbox_events
           SET dead_at = NULL, attempts = 0, available_at = now(), last_error = NULL
         WHERE id = $1 AND dead_at IS NOT NULL`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  /** Counts for the integration health panel and for alerting. */
  async health(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ status: string; n: string; oldest: string | null }>(
        `SELECT CASE WHEN dead_at IS NOT NULL THEN 'dead'
                     WHEN published_at IS NOT NULL THEN 'published'
                     ELSE 'pending' END AS status,
                count(*)::text AS n, min(created_at)::text AS oldest
         FROM outbox_events GROUP BY 1`,
      );
      return rows.map((row) => ({ status: row.status, count: Number(row.n), oldest: row.oldest }));
    });
  }
}

/**
 * Exponential backoff with a ceiling, jittered.
 *
 * The jitter matters more than the curve: without it, a provider coming back
 * from an outage gets every event that failed during it in one synchronised
 * burst, which is a good way to be rate limited straight back into failure.
 */
export function backoffSeconds(attempts: number): number {
  const base = Math.min(2 ** Math.max(0, attempts - 1) * 5, 3600);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Errors go in a text column and get read by humans; a stack trace does not need to be complete to be useful. */
function truncate(error: string): string {
  return error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
}
