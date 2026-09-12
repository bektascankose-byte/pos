import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { createVendorSchema, createPurchaseOrderSchema, receivePurchaseOrderSchema } from '@snappos/contracts';
import { PurchasingService } from './purchasing.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'purchasing', version: '1' })
export class PurchasingController {
  constructor(
    private readonly purchasing: PurchasingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('vendors')
  @RequirePermissions('purchasing.view')
  listVendors(@CurrentUser() user: AuthenticatedUser) {
    return this.purchasing.listVendors(user.orgId);
  }

  @Post('vendors')
  @RequirePermissions('vendor.manage')
  createVendor(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createVendorSchema)) body: ReturnType<typeof createVendorSchema.parse>,
  ) {
    return this.purchasing.createVendor(user.orgId, user.userId, body);
  }

  @Get('purchase-orders')
  @RequirePermissions('purchasing.view')
  listPurchaseOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query('store_id') storeId?: string,
    @Query('status') status?: string,
  ) {
    return this.purchasing.listPurchaseOrders(user.orgId, { storeId, status });
  }

  @Get('purchase-orders/:id')
  @RequirePermissions('purchasing.view')
  getPurchaseOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.purchasing.getPurchaseOrder(user.orgId, id);
  }

  @Post('purchase-orders')
  @RequirePermissions('purchasing.create')
  createPurchaseOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createPurchaseOrderSchema)) body: ReturnType<typeof createPurchaseOrderSchema.parse>,
  ) {
    return this.purchasing.createPurchaseOrder(user.orgId, user.userId, body);
  }

  /**
   * Receive stock against a PO. Requires an Idempotency-Key for the same
   * reason posting inventory movements does: this changes stock, and a
   * retried request without one would receive the same shipment twice.
   */
  @Post('purchase-orders/:id/receive')
  @RequirePermissions('purchasing.receive')
  async receivePurchaseOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(receivePurchaseOrderSchema)) body: ReturnType<typeof receivePurchaseOrderSchema.parse>,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key) {
      throw new ApiException(
        'validation_failed',
        'POST /v1/purchasing/purchase-orders/:id/receive requires an Idempotency-Key header',
        { retryable: false },
      );
    }

    const outcome = await this.idempotency.execute(
      user.orgId,
      key,
      'POST /v1/purchasing/purchase-orders/:id/receive',
      { id, body },
      async () => ({ status: 200, body: await this.purchasing.receivePurchaseOrder(user.orgId, user.userId, id, body) }),
    );

    return outcome.body;
  }
}
