import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { OutboxPump } from './outbox.pump.js';
import { WebhookService } from '../webhooks/webhook.service.js';

/**
 * Global, for the same reason `AuditModule` is: any module that changes state
 * worth telling somebody about needs to emit, and threading this through
 * every feature module's imports would be noise.
 *
 * The pump is exported so feature modules can register their handlers from
 * their own `onModuleInit` -- the module that owns an event type is the one
 * that should say how it is delivered, rather than a central switch statement
 * that has to be edited every time a phase lands.
 */
@Global()
@Module({
  providers: [OutboxService, OutboxPump, WebhookService],
  exports: [OutboxService, OutboxPump, WebhookService],
})
export class OutboxModule {}
