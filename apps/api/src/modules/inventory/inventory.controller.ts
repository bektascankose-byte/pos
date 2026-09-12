import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { postMovementBatchSchema, ledgerQuerySchema } from '@snappos/contracts';
import { InventoryService } from './inventory.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('levels')
  @RequirePermissions('inventory.view')
  levels(
    @CurrentUser() user: AuthenticatedUser,
    @Query('store_id') storeId: string,
    @Query('variant_ids') variantIds?: string,
  ) {
    return this.inventory.levelsForStore(
      user.orgId,
      storeId,
      variantIds ? variantIds.split(',') : undefined,
    );
  }

  /** Every active variant for a store, with catalog context -- what the back office's stock list shows. */
  @Get('stock')
  @RequirePermissions('inventory.view')
  stockList(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId: string) {
    return this.inventory.stockList(user.orgId, storeId);
  }

  @Get('stock/:variantId')
  @RequirePermissions('inventory.view')
  async stockDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
    @Query('store_id') storeId: string,
  ) {
    const row = await this.inventory.stockDetail(user.orgId, storeId, variantId);
    if (!row) throw ApiException.notFound('variant');
    return row;
  }

  @Get('ledger')
  @RequirePermissions('inventory.view')
  ledger(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    const params = ledgerQuerySchema.parse(query);
    return this.inventory.ledger(user.orgId, {
      storeId: params.store_id,
      variantId: params.variant_id,
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /**
   * Post stock movements.
   *
   * Requires an Idempotency-Key. This endpoint changes stock, and a client that
   * retries a timed out request without one would deduct twice. Rather than
   * treating the header as optional and hoping, the endpoint refuses without it.
   */
  @Post('movements')
  @RequirePermissions('inventory.adjust')
  async postMovements(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(postMovementBatchSchema)) body: ReturnType<typeof postMovementBatchSchema.parse>,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key) {
      throw new ApiException(
        'validation_failed',
        'POST /v1/inventory/movements requires an Idempotency-Key header',
        { retryable: false },
      );
    }

    const outcome = await this.idempotency.execute(
      user.orgId,
      key,
      'POST /v1/inventory/movements',
      body,
      async () => {
        const result = await this.inventory.postMovements(
          user.orgId,
          user.userId,
          body.movements,
          { type: body.reference_type, id: body.reference_id },
        );
        return { status: 201, body: result };
      },
    );

    return outcome.body;
  }

  /**
   * Prove the levels still equal the ledger.
   *
   * Exposed as an endpoint as well as a nightly job so that a suspicious owner
   * can check on demand rather than waiting until morning.
   */
  @Get('reconcile')
  @RequirePermissions('inventory.view')
  reconcile(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.inventory.reconcile(user.orgId, storeId);
  }
}
