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
   */
  @Post('batch')
  @RequirePermissions('sync.upload')
  ingest(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(syncBatchSchema)) body: ReturnType<typeof syncBatchSchema.parse>,
  ) {
    return this.sync.ingest(user.orgId, body, new Date());
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
