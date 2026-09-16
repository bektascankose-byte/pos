import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';

export interface InboundWebhook {
  provider: string;
  /** The provider's own id for this event, when it sends one. The dedup key. */
  providerEventId?: string | undefined;
  eventType?: string | undefined;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
}

export interface RecordedWebhook {
  id: string;
  /** False when this exact provider event was already stored -- the caller should answer 200 and do nothing. */
  isNew: boolean;
}

/**
 * How anything from outside gets in.
 *
 * Four rules, each one earned by a way this goes wrong in production:
 *
 * 1. **Resolve the org before verifying.** The signing secret belongs to the
 *    organization, so there is no way to check a signature without first
 *    knowing whose endpoint was hit. Anything that cannot be attributed is
 *    refused at the door rather than stored unattributable.
 * 2. **Verify before parsing.** Signature checks run over the raw bytes. A
 *    body that has been through `JSON.parse` and back is a different string,
 *    and verifying that one proves nothing.
 * 3. **Store, then process.** The row is committed before any work happens,
 *    so a provider that times out and resends finds the first copy already
 *    recorded instead of causing the work twice.
 * 4. **Answer 200 to a duplicate.** Every courier and processor resends. A
 *    non-2xx tells them to try harder at something already done.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Store an arriving webhook, deduplicated on the provider's event id.
   *
   * `ON CONFLICT DO NOTHING` against the partial unique index is what makes
   * this safe under concurrency: two copies of the same event arriving at the
   * same instant race in the database, and exactly one wins.
   */
  async record(orgId: string, input: InboundWebhook): Promise<RecordedWebhook> {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO webhook_events
           (org_id, provider, provider_event_id, event_type, signature_verified, payload)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (org_id, provider, provider_event_id)
           WHERE provider_event_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          input.provider,
          input.providerEventId ?? null,
          input.eventType ?? null,
          input.signatureVerified,
          JSON.stringify(input.payload),
        ],
      );

      if (rows[0]) return { id: rows[0].id, isNew: true };

      const { rows: existing } = await tx.query<{ id: string }>(
        `SELECT id FROM webhook_events
         WHERE provider = $1 AND provider_event_id = $2`,
        [input.provider, input.providerEventId ?? null],
      );
      return { id: existing[0]!.id, isNew: false };
    });
  }

  async markProcessed(orgId: string, id: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `UPDATE webhook_events SET status = 'processed', processed_at = now(), last_error = NULL
         WHERE id = $1`,
        [id],
      );
    });
  }

  /** Recorded but not acted on -- an event type this system has no interest in. Distinct from a failure. */
  async markIgnored(orgId: string, id: string, reason: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(`UPDATE webhook_events SET status = 'ignored', last_error = $2 WHERE id = $1`, [
        id,
        reason,
      ]);
    });
  }

  async markFailed(orgId: string, id: string, error: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.query(
        `UPDATE webhook_events
           SET status = 'failed', attempts = attempts + 1, last_error = $2
         WHERE id = $1`,
        [id, error.length > 2000 ? `${error.slice(0, 2000)}…` : error],
      );
    });
  }

  async health(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ provider: string; status: string; n: string; latest: string | null }>(
        `SELECT provider, status, count(*)::text AS n, max(received_at)::text AS latest
         FROM webhook_events GROUP BY provider, status ORDER BY provider, status`,
      );
      return rows.map((r) => ({
        provider: r.provider,
        status: r.status,
        count: Number(r.n),
        latest: r.latest,
      }));
    });
  }
}

/**
 * HMAC signature check over the raw body.
 *
 * `timingSafeEqual` rather than `===` because comparing secrets with a
 * short-circuiting comparison leaks their contents a byte at a time to anyone
 * willing to measure. It throws on a length mismatch, which is itself an
 * observable difference, so lengths are compared first and a mismatch is
 * simply false.
 */
export function verifyHmac(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = decodeSignature(signature);
  if (!provided || provided.length !== expected.length) return false;

  return timingSafeEqual(expected, provided);
}

/** Providers disagree about hex versus base64; both are accepted, anything else is a miss. */
function decodeSignature(signature: string): Buffer | null {
  const trimmed = signature.trim().replace(/^sha256=/i, '');
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Reject a signed request whose timestamp is outside the tolerance.
 *
 * A valid signature is valid forever, so without this, anyone who captures one
 * request can replay it indefinitely -- which for a delivery webhook means
 * replaying "delivered" onto an order that never was. Five minutes is the
 * usual provider tolerance and is generous for clock drift.
 */
export function withinReplayWindow(timestamp: string | number, toleranceSeconds = 300): boolean {
  const seconds = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  // Providers send seconds; a value that large is milliseconds.
  const asMs = seconds > 1e11 ? seconds : seconds * 1000;
  return Math.abs(Date.now() - asMs) <= toleranceSeconds * 1000;
}
