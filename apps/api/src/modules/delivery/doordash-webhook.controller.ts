import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { doordashCourierEvent } from '@snappos/contracts';
import { Public } from '../../platform/auth/auth.guard.js';
import { DatabaseService } from '../../platform/database/database.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { WebhookService } from '../../platform/webhooks/webhook.service.js';
import { DeliveryService } from './delivery.service.js';

interface DoorDashWebhook {
  event_name?: string;
  external_delivery_id?: string;
  created_at?: string;
  dasher_name?: string;
  tracking_url?: string;
  support_reference?: string;
  fee?: number;
  pickup_time_estimated?: string;
  dropoff_time_estimated?: string;
  cancellation_reason?: string;
  delivery_status?: string;
}

/**
 * Where DoorDash reports on deliveries.
 *
 * DoorDash signs nothing: it sends back, in the `Authorization` header, a value
 * the shop typed into DoorDash's developer portal. The same value is set here
 * as `DOORDASH_WEBHOOK_AUTHORIZATION` and compared in constant time. A request
 * without it is refused before its body is looked at.
 *
 * Every accepted report is stored first (deduplicated -- DoorDash sends each
 * one up to three times) and then applied. A report for a delivery this system
 * never booked is stored as ignored rather than refused, because a non-2xx
 * answer only makes DoorDash send it again.
 */
@Controller({ path: 'webhooks/doordash', version: '1' })
@Public()
export class DoorDashWebhookController {
  private readonly logger = new Logger(DoorDashWebhookController.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly webhooks: WebhookService,
    private readonly delivery: DeliveryService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers('authorization') authorization: string | undefined, @Body() body: DoorDashWebhook) {
    const expected = process.env.DOORDASH_WEBHOOK_AUTHORIZATION;
    if (!expected) {
      throw new ApiException('provider_unavailable', 'DoorDash webhooks are not configured on this server', {
        retryable: false,
      });
    }
    if (!sameSecret(authorization ?? '', expected)) {
      throw new ApiException('unauthenticated', 'webhook authorization did not match');
    }

    const externalId = body.external_delivery_id;
    const eventName = body.event_name;
    if (!externalId || !eventName) return { status: 'ignored' };

    const owner = await this.db.unscoped(async (client) => {
      const { rows } = await client.query<{ org_id: string; order_id: string }>(
        `SELECT org_id, order_id FROM delivery_lookup_order($1)`,
        [externalId],
      );
      return rows[0] ?? null;
    });
    if (!owner) {
      // A quote's id, or a delivery from before a database reset. Nothing to do.
      this.logger.warn({ eventName }, 'DoorDash reported on a delivery this system does not know');
      return { status: 'ignored' };
    }

    const recorded = await this.webhooks.record(owner.org_id, {
      provider: 'doordash',
      providerEventId: `${externalId}:${eventName}:${body.created_at ?? ''}`,
      eventType: eventName,
      signatureVerified: true,
      payload: body as Record<string, unknown>,
    });
    if (!recorded.isNew) return { status: 'duplicate' };

    const event = doordashCourierEvent(eventName);
    if (!event) {
      await this.webhooks.markIgnored(owner.org_id, recorded.id, `${eventName} changes nothing about an order`);
      return { status: 'ignored' };
    }

    try {
      await this.delivery.applyCourierEvent(owner.org_id, owner.order_id, event, {
        providerStatus: body.delivery_status ?? eventName.toLowerCase(),
        driverName: body.dasher_name,
        trackingUrl: body.tracking_url,
        supportReference: body.support_reference,
        feeMinor: typeof body.fee === 'number' ? BigInt(body.fee) : undefined,
        estimatedPickupAt: body.pickup_time_estimated,
        estimatedDropoffAt: body.dropoff_time_estimated,
        cancellationReason: body.cancellation_reason ? `DoorDash: ${body.cancellation_reason}` : undefined,
        occurredAt: body.created_at,
      });
      await this.webhooks.markProcessed(owner.org_id, recorded.id);
      return { status: 'processed' };
    } catch (e) {
      // Stored and marked, and still a 200: the report is kept for a person to
      // look at, and resending it would fail the same way.
      await this.webhooks.markFailed(owner.org_id, recorded.id, e instanceof Error ? e.message : 'failed');
      this.logger.error({ eventName, err: e instanceof Error ? e.message : e }, 'a DoorDash report could not be applied');
      return { status: 'failed' };
    }
  }
}

/** Compare secrets without leaking their contents through timing. */
function sameSecret(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
