import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { syncBatchSchema, changesQuerySchema } from '@snappos/contracts';
import { SyncService } from './sync.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Upload. Carries no Idempotency-Key header because it does not need one:
   * every entity in the batch already carries its own UUIDv7, which serves as
   * the key. There is nothing separate to get wrong.
   *
   * `sync.upload` gates the endpoint; each entity is additionally checked
   * against the permission that governs its own action, so this route cannot
   * become a way around the ones that guard /sales and /refunds.
   */
  @Post('batch')
  @RequirePermissions('sync.upload')
  ingest(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(syncBatchSchema)) body: ReturnType<typeof syncBatchSchema.parse>,
  ) {
    return this.sync.ingest(user.orgId, body, new Date(), user.permissions);
  }

  /**
   * Bootstrap: everything this store sells, in one response.
   *
   * A register calls this once when it is claimed, then keeps up with
   * `/changes`. Gated on sync.download like the change feed.
   */
  @Get('catalog')
  @RequirePermissions('sync.download')
  catalog(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId: string) {
    return this.sync.catalogSnapshot(user.orgId, storeId);
  }

  @Get('changes')
  @RequirePermissions('sync.download')
  changes(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    const params = changesQuerySchema.parse(query);
    return this.sync.changes(user.orgId, {
      since: params.since,
      limit: params.limit,
      storeId: params.store_id,
      scopes: params.scopes,
    });
  }
}
