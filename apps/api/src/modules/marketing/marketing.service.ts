import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import type {
  CreateSegment,
  UpdateSegment,
  CreateCampaign,
  UpdateCampaign,
  SegmentDefinition,
  MessageChannel,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { MessagingService } from '../../platform/messaging/messaging.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { buildSegmentQuery, consentGrantedSql, suppressedSql } from './segment-query.js';

const SEGMENT_COLUMNS = `id, name, description, definition, created_at, updated_at`;

const CAMPAIGN_COLUMNS = `c.id, c.name, c.channel, c.segment_id, s.name AS segment_name, c.subject, c.body,
       c.status, c.recipient_count, c.sent_count, c.failed_count, c.skipped_count,
       c.created_at, c.sent_at`;

/** How many matched customers the preview lists by name. A sanity check, not a recipient list. */
const PREVIEW_SAMPLE = 8;

/**
 * A cap on one send, so a mistake in a segment cannot mail the entire
 * customer base before anyone notices. Raising it is a deliberate act.
 */
const MAX_RECIPIENTS = 5_000;

@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
  ) {}

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  async listSegments(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${SEGMENT_COLUMNS} FROM customer_segments ORDER BY name`,
      );
      return rows;
    });
  }

  async getSegment(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(`SELECT ${SEGMENT_COLUMNS} FROM customer_segments WHERE id = $1`, [id]);
      const segment = rows[0];
      if (!segment) throw ApiException.notFound('segment');
      return segment;
    });
  }

  async createSegment(orgId: string, actorUserId: string, input: CreateSegment) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO customer_segments (org_id, name, description, definition, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3::jsonb, $4)
         RETURNING ${SEGMENT_COLUMNS}`,
        [input.name, input.description ?? null, JSON.stringify(serializeDefinition(input.definition)), actorUserId],
      );
      const segment = rows[0]!;

      await this.audit.record(tx, {
        action: 'marketing.segment_create',
        entityType: 'customer_segment',
        entityId: segment.id,
        actorUserId,
        newValue: { name: input.name },
      });

      return segment;
    });
  }

  async updateSegment(orgId: string, actorUserId: string, id: string, input: UpdateSegment) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE customer_segments SET
           name        = COALESCE($2, name),
           description = COALESCE($3, description),
           definition  = COALESCE($4::jsonb, definition)
         WHERE id = $1
         RETURNING ${SEGMENT_COLUMNS}`,
        [
          id,
          input.name ?? null,
          input.description ?? null,
          input.definition ? JSON.stringify(serializeDefinition(input.definition)) : null,
        ],
      );
      const segment = rows[0];
      if (!segment) throw ApiException.notFound('segment');

      await this.audit.record(tx, {
        action: 'marketing.segment_update',
        entityType: 'customer_segment',
        entityId: id,
        actorUserId,
        newValue: { name: input.name ?? null },
      });

      return segment;
    });
  }

  /**
   * A segment deletes rather than archives -- unlike every other entity here.
   *
   * A segment is a saved question, not a record of anything that happened.
   * Nothing points at it except campaigns, whose own `segment_id` is
   * `ON DELETE SET NULL` precisely so a sent campaign keeps its recipient
   * rows -- the record of who was actually mailed -- after the question
   * behind it is thrown away.
   */
  async deleteSegment(orgId: string, actorUserId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rowCount } = await tx.query(`DELETE FROM customer_segments WHERE id = $1`, [id]);
      if (rowCount === 0) throw ApiException.notFound('segment');

      await this.audit.record(tx, {
        action: 'marketing.segment_delete',
        entityType: 'customer_segment',
        entityId: id,
        actorUserId,
      });

      return { deleted: true };
    });
  }

  /**
   * How many people a segment matches, and how many of those can lawfully be
   * mailed.
   *
   * These are two different numbers and showing only the first is how a shop
   * gets into trouble -- somebody reads "412 customers" and takes it for the
   * size of the send. The breakdown says exactly where the rest went: no
   * consent, suppressed, or no address on this channel.
   *
   * Uses the same compiled fragments the send does, so a preview cannot
   * disagree with what actually goes out.
   */
  async previewSegment(orgId: string, definition: SegmentDefinition, channel: MessageChannel) {
    return this.db.withOrg(orgId, (tx) => this.previewSegmentTx(tx, definition, channel));
  }

  private async previewSegmentTx(tx: PoolClient, definition: SegmentDefinition, channel: MessageChannel) {
    const addressColumn = channel === 'email' ? 'c.email' : 'c.phone';
    // $1 is the channel; the segment's own values start at $2.
    const { where, params } = buildSegmentQuery(definition, 2);
    const allParams = [channel, ...params];

    const { rows } = await tx.query<{
      matched: number;
      reachable: number;
      no_consent: number;
      suppressed: number;
      no_address: number;
    }>(
      `WITH matched AS (
         SELECT c.id,
                ${addressColumn} AS address,
                ${consentGrantedSql('$1')} AS consented,
                (${addressColumn} IS NOT NULL AND ${suppressedSql('$1', addressColumn)}) AS suppressed
         FROM customers c
         WHERE ${where}
       )
       SELECT count(*)::int AS matched,
              count(*) FILTER (WHERE consented AND NOT suppressed AND address IS NOT NULL)::int AS reachable,
              count(*) FILTER (WHERE NOT consented)::int AS no_consent,
              count(*) FILTER (WHERE consented AND suppressed)::int AS suppressed,
              count(*) FILTER (WHERE consented AND NOT suppressed AND address IS NULL)::int AS no_address
       FROM matched`,
      allParams,
    );

    const { rows: sample } = await tx.query<{
      id: string;
      name: string;
      address: string | null;
      consented: boolean;
      suppressed: boolean;
    }>(
      `SELECT c.id,
              COALESCE(NULLIF(btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''), '(no name)') AS name,
              ${addressColumn} AS address,
              ${consentGrantedSql('$1')} AS consented,
              (${addressColumn} IS NOT NULL AND ${suppressedSql('$1', addressColumn)}) AS suppressed
       FROM customers c
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT ${PREVIEW_SAMPLE}`,
      allParams,
    );

    return {
      ...rows[0]!,
      sample: sample.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        reachable: row.consented && !row.suppressed && row.address !== null,
        reason: reachabilityReason(row.consented, row.suppressed, row.address, channel),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Campaigns
  // ---------------------------------------------------------------------------

  async listCampaigns(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${CAMPAIGN_COLUMNS}
         FROM campaigns c LEFT JOIN customer_segments s ON s.id = c.segment_id
         ORDER BY c.created_at DESC LIMIT 100`,
      );
      return rows;
    });
  }

  async getCampaign(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const campaign = await this.loadCampaign(tx, id);
      const { rows: recipients } = await tx.query(
        `SELECT r.id, r.customer_id,
                COALESCE(NULLIF(btrim(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')), ''), '(no name)') AS customer_name,
                r.address, r.status, r.skip_reason, r.error, r.sent_at
         FROM campaign_recipients r
         JOIN customers cu ON cu.id = r.customer_id
         WHERE r.campaign_id = $1
         ORDER BY r.status, cu.last_name NULLS LAST
         LIMIT 500`,
        [id],
      );
      return { ...campaign, recipients };
    });
  }

  /**
   * A campaign starts as a draft and is never sent by the act of creating it.
   * Composing and sending are separate calls for the same reason importing is
   * -- the irreversible step gets its own deliberate click.
   */
  async createCampaign(orgId: string, actorUserId: string, input: CreateCampaign) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO campaigns (org_id, name, channel, segment_id, subject, body, created_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [input.name, input.channel, input.segment_id, input.subject ?? null, input.body, actorUserId],
      );

      await this.audit.record(tx, {
        action: 'marketing.campaign_create',
        entityType: 'campaign',
        entityId: rows[0]!.id,
        actorUserId,
        newValue: { name: input.name, channel: input.channel },
      });

      return this.loadCampaign(tx, rows[0]!.id);
    });
  }

  async updateCampaign(orgId: string, actorUserId: string, id: string, input: UpdateCampaign) {
    return this.db.withOrg(orgId, async (tx) => {
      const existing = await this.loadCampaign(tx, id);
      if (existing.status !== 'draft') {
        throw new ApiException('conflict', 'this campaign has already been sent and cannot be edited', {
          retryable: false,
        });
      }

      await tx.query(
        `UPDATE campaigns SET
           name       = COALESCE($2, name),
           subject    = COALESCE($3, subject),
           body       = COALESCE($4, body),
           segment_id = COALESCE($5, segment_id)
         WHERE id = $1`,
        [id, input.name ?? null, input.subject ?? null, input.body ?? null, input.segment_id ?? null],
      );

      await this.audit.record(tx, {
        action: 'marketing.campaign_update',
        entityType: 'campaign',
        entityId: id,
        actorUserId,
      });

      return this.loadCampaign(tx, id);
    });
  }

  /**
   * Send it.
   *
   * The consent gate lives here and nowhere else, and there is no flag that
   * bypasses it. Every matched customer gets a recipient row saying what
   * happened to them -- sent, failed, or skipped with a reason -- so a
   * campaign that mailed 40 of 120 can say where the other 80 went.
   *
   * Recipients are resolved and written in one transaction, then the actual
   * provider calls happen *outside* it. Holding a database transaction open
   * across four hundred network calls would pin a pooled connection for
   * minutes and roll back the entire record of a half-finished send if one
   * timed out -- and a send is not undoable by rolling back a transaction:
   * the mail has left.
   */
  async sendCampaign(orgId: string, actorUserId: string, id: string) {
    const prepared = await this.db.withOrg(orgId, async (tx) => {
      const campaign = await this.loadCampaign(tx, id);
      if (campaign.status !== 'draft') {
        throw new ApiException('conflict', `this campaign is already ${campaign.status}`, { retryable: false });
      }
      if (!campaign.segment_id) {
        throw new ApiException('validation_failed', 'this campaign has no segment to send to', {
          retryable: false,
        });
      }

      // Promotional SMS is refused outright rather than attempted. US carriers
      // filter SHAFT content -- tobacco and vape included -- downstream of
      // consent, so this would fail per recipient with Twilio 30458 while
      // accumulating violations against the shop's number. Better to say so
      // than to burn a sending reputation discovering it.
      if (campaign.channel === 'sms') {
        throw new ApiException(
          'validation_failed',
          'promotional text messages are blocked by US carriers for tobacco and vape retail (SHAFT), whoever has opted in — send this as an email, or register through a specialist for SMS first. Texts can still carry receipts and order notices.',
          { retryable: false },
        );
      }
      if (!this.messaging.emailConfigured()) {
        throw new ApiException(
          'provider_unavailable',
          'email sending is not configured on this server — ask an admin to set SENDGRID_API_KEY and MARKETING_FROM_EMAIL',
          { retryable: false },
        );
      }

      const { rows: segmentRows } = await tx.query<{ definition: SegmentDefinition }>(
        `SELECT definition FROM customer_segments WHERE id = $1`,
        [campaign.segment_id],
      );
      if (!segmentRows[0]) throw ApiException.notFound('segment');

      const channel = campaign.channel as MessageChannel;
      const addressColumn = channel === 'email' ? 'c.email' : 'c.phone';
      const { where, params } = buildSegmentQuery(segmentRows[0].definition, 2);

      const { rows: matched } = await tx.query<{
        id: string;
        first_name: string | null;
        address: string | null;
        consented: boolean;
        suppressed: boolean;
      }>(
        `SELECT c.id, c.first_name,
                ${addressColumn} AS address,
                ${consentGrantedSql('$1')} AS consented,
                (${addressColumn} IS NOT NULL AND ${suppressedSql('$1', addressColumn)}) AS suppressed
         FROM customers c
         WHERE ${where}
         LIMIT ${MAX_RECIPIENTS + 1}`,
        [channel, ...params],
      );

      if (matched.length > MAX_RECIPIENTS) {
        throw new ApiException(
          'validation_failed',
          `this segment matches more than ${MAX_RECIPIENTS.toLocaleString()} customers, which is the most one campaign may send to — narrow the segment`,
          { retryable: false },
        );
      }

      const sendable: { recipientId: string; customerId: string; firstName: string | null; address: string; token: string }[] = [];

      for (const row of matched) {
        const token = randomBytes(24).toString('base64url');
        const reachable = row.consented && !row.suppressed && row.address !== null;
        const reason = reachabilityReason(row.consented, row.suppressed, row.address, channel);

        const { rows: recipientRows } = await tx.query<{ id: string }>(
          `INSERT INTO campaign_recipients
             (org_id, campaign_id, customer_id, address, status, skip_reason, unsubscribe_token)
           VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)
           ON CONFLICT (campaign_id, customer_id) DO NOTHING
           RETURNING id`,
          [id, row.id, row.address, reachable ? 'pending' : 'skipped', reachable ? null : reason, token],
        );
        const recipientId = recipientRows[0]?.id;
        if (reachable && recipientId && row.address) {
          sendable.push({
            recipientId,
            customerId: row.id,
            firstName: row.first_name,
            address: row.address,
            token,
          });
        }
      }

      const skipped = matched.length - sendable.length;
      await tx.query(
        `UPDATE campaigns SET status = 'sending', recipient_count = $2, skipped_count = $3 WHERE id = $1`,
        [id, matched.length, skipped],
      );

      await this.audit.record(tx, {
        action: 'marketing.campaign_send',
        entityType: 'campaign',
        entityId: id,
        actorUserId,
        newValue: { matched: matched.length, sendable: sendable.length, skipped },
      });

      return { campaign, sendable, matched: matched.length, skipped };
    });

    // --- outside the transaction: the provider calls ---
    let sent = 0;
    let failed = 0;

    for (const recipient of prepared.sendable) {
      const body = renderBody(prepared.campaign.body, recipient.firstName);
      const outcome = await this.messaging.sendEmail({
        to: recipient.address,
        subject: prepared.campaign.subject ?? '',
        body: `${body}\n\n---\nTo stop receiving these, visit:\n${unsubscribeUrl(recipient.token)}`,
        // The header is what a mail client's own "unsubscribe" button uses.
        // Offering it is why a recipient reports a message as unwanted rather
        // than as spam, which is the difference between losing one address
        // and losing a sending reputation.
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl(recipient.token)}>` },
      });

      if (outcome.ok) sent += 1;
      else failed += 1;

      await this.db.withOrg(orgId, async (tx) => {
        await tx.query(
          `UPDATE campaign_recipients
             SET status = $2, provider_message_id = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
           WHERE id = $1`,
          [
            recipient.recipientId,
            outcome.ok ? 'sent' : 'failed',
            outcome.provider_message_id ?? null,
            outcome.error ?? null,
          ],
        );
      });
    }

    return this.db.withOrg(orgId, async (tx) => {
      // 'failed' only when nothing at all got out -- a send where most
      // recipients received the mail is not a failed send, and calling it one
      // would invite someone to retry it and mail everyone twice.
      const status = sent === 0 && failed > 0 ? 'failed' : 'sent';
      await tx.query(
        `UPDATE campaigns
           SET status = $2::campaign_status, sent_count = $3, failed_count = $4,
               sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
         WHERE id = $1`,
        [id, status, sent, failed],
      );
      return {
        recipient_count: prepared.matched,
        sent_count: sent,
        failed_count: failed,
        skipped_count: prepared.skipped,
        status,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Suppressions and unsubscribe
  // ---------------------------------------------------------------------------

  async listSuppressions(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, channel, address, reason, created_at FROM message_suppressions
         ORDER BY created_at DESC LIMIT 500`,
      );
      return rows;
    });
  }

  /**
   * Act on an unsubscribe link. No organization context and no session: the
   * person clicking is a customer reading an email, so this goes through the
   * `marketing_unsubscribe` SECURITY DEFINER function -- the same shape the
   * authentication lookups use, for the same reason.
   */
  async unsubscribe(token: string) {
    return this.db.unscoped(async (client) => {
      const { rows } = await client.query<{ found: boolean; channel: string | null }>(
        `SELECT * FROM marketing_unsubscribe($1)`,
        [token],
      );
      const result = rows[0];
      if (!result?.found) {
        throw ApiException.notFound('unsubscribe link');
      }
      return { unsubscribed: true, channel: result.channel };
    });
  }

  private async loadCampaign(tx: PoolClient, id: string) {
    const { rows } = await tx.query(
      `SELECT ${CAMPAIGN_COLUMNS}
       FROM campaigns c LEFT JOIN customer_segments s ON s.id = c.segment_id
       WHERE c.id = $1`,
      [id],
    );
    const campaign = rows[0];
    if (!campaign) throw ApiException.notFound('campaign');
    return campaign as {
      id: string;
      name: string;
      channel: string;
      segment_id: string | null;
      subject: string | null;
      body: string;
      status: string;
    };
  }
}

/**
 * Money on a segment definition arrives as a branded bigint and has to reach
 * jsonb as a string -- `JSON.stringify` throws on a BigInt outright.
 */
function serializeDefinition(definition: SegmentDefinition): Record<string, unknown> {
  return {
    ...definition,
    ...(definition.min_lifetime_spend_minor !== undefined
      ? { min_lifetime_spend_minor: definition.min_lifetime_spend_minor.toString() }
      : {}),
  };
}

/** Why this person is not being mailed, in the words the campaign screen shows. */
function reachabilityReason(
  consented: boolean,
  suppressed: boolean,
  address: string | null,
  channel: MessageChannel,
): string | null {
  if (!consented) return 'no marketing opt-in on record';
  if (suppressed) return 'unsubscribed or previously bounced';
  if (!address) return `no ${channel === 'email' ? 'email address' : 'phone number'} on file`;
  return null;
}

/**
 * The only two placeholders a campaign body understands. Deliberately a
 * find-and-replace rather than a template engine: an expression evaluator
 * pointed at a customer database, driven by a field a user types, is a much
 * larger thing than "put their name in the greeting".
 */
function renderBody(body: string, firstName: string | null): string {
  return body
    .replaceAll('{{first_name}}', firstName?.trim() || 'there')
    .replaceAll('{{shop_name}}', process.env.MARKETING_FROM_NAME ?? 'us');
}

function unsubscribeUrl(token: string): string {
  const base = process.env.PUBLIC_APP_URL ?? 'http://localhost:3001';
  return `${base}/unsubscribe/${token}`;
}
