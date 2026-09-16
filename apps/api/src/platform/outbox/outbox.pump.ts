import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OutboxService, type ClaimedEvent } from './outbox.service.js';

/** What a handler is given. `orgId` is the event's own org, not the caller's -- the pump serves every tenant. */
export interface OutboxContext {
  orgId: string;
  correlationId: string | null;
  attempts: number;
}

export type OutboxHandler = (payload: Record<string, unknown>, ctx: OutboxContext) => Promise<void>;

const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 1000);
const BATCH = Number(process.env.OUTBOX_BATCH ?? 25);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 8);

/**
 * Publishes what `OutboxService` recorded.
 *
 * **Runs in the API process, for now.** `docs/ARCHITECTURE.md` plans a separate
 * `services/worker` deploy, and that is still right at volume -- but the thing
 * that makes an outbox correct is the shared transaction on the write side,
 * not where the reader runs. Claiming with `SKIP LOCKED` means moving this to
 * its own process later is a deployment change and not a rewrite: start the
 * same class there, stop starting it here, and any number of copies can run
 * side by side in between without double-publishing.
 *
 * Deliberately no queue library. BullMQ would add Redis as a hard dependency
 * and a second store to keep consistent with Postgres, to schedule work that
 * Postgres is already storing transactionally. At one store's volume that is
 * a liability, not a feature.
 *
 * A handler must be idempotent. Delivery is at-least-once by construction: a
 * process that dies between doing the work and marking the row delivered will
 * do that work again, and no amount of care here changes that.
 */
@Injectable()
export class OutboxPump implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPump.name);
  private readonly handlers = new Map<string, OutboxHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly outbox: OutboxService) {}

  /**
   * Register the handler for one event type.
   *
   * One handler per type, and a second registration is a programming error
   * rather than a silent replacement -- two modules quietly fighting over
   * `order.placed` is exactly the kind of bug that only shows up in
   * production, as a notification sent twice.
   */
  register(eventType: string, handler: OutboxHandler): void {
    if (this.handlers.has(eventType)) {
      throw new Error(`outbox handler for "${eventType}" is already registered`);
    }
    this.handlers.set(eventType, handler);
  }

  onModuleInit(): void {
    if (process.env.OUTBOX_DISABLED === 'true') {
      this.logger.warn('outbox pump disabled by OUTBOX_DISABLED');
      return;
    }
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Let an in-flight tick finish rather than tearing the pool out from under
    // it: a handler killed mid-write is the one case that turns at-least-once
    // delivery into a half-applied side effect.
    for (let i = 0; i < 50 && this.running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), POLL_MS);
    // Never hold the process open for a poll that has not fired yet.
    this.timer.unref?.();
  }

  /** Exposed so tests can drive a tick directly instead of waiting on a timer. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let handled = 0;

    try {
      const events = await this.outbox.claim(BATCH);
      for (const event of events) {
        if (await this.deliver(event)) handled += 1;
      }
    } catch (e) {
      // A failure to claim is infrastructure, not an event: log it and let the
      // next tick try. Throwing here would kill the only pump in the process.
      this.logger.error({ err: message(e) }, 'outbox claim failed');
    } finally {
      this.running = false;
      this.schedule();
    }

    return handled;
  }

  private async deliver(event: ClaimedEvent): Promise<boolean> {
    const handler = this.handlers.get(event.eventType);

    // No handler is not a failure. Events are emitted by the module that owns
    // the fact, and consumed by whichever modules care -- during a phased
    // build that legitimately includes none yet. Retrying forever for a
    // listener that does not exist would fill the dead letters with noise.
    if (!handler) {
      await this.outbox.markDelivered(event.id);
      return false;
    }

    try {
      await handler(event.payload, {
        orgId: event.orgId,
        correlationId: event.correlationId,
        attempts: event.attempts,
      });
      await this.outbox.markDelivered(event.id);
      return true;
    } catch (e) {
      const error = message(e);
      await this.outbox.markFailed(event.id, event.attempts, error, MAX_ATTEMPTS);
      this.logger.warn(
        {
          outboxId: event.id,
          eventType: event.eventType,
          attempts: event.attempts,
          correlationId: event.correlationId,
          err: error,
        },
        event.attempts >= MAX_ATTEMPTS ? 'outbox event dead' : 'outbox delivery failed, will retry',
      );
      return false;
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}
