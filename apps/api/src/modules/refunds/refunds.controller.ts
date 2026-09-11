import { Controller, Get, Param, Query } from '@nestjs/common';
import { RefundsService } from './refunds.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'refunds', version: '1' })
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @RequirePermissions('report.sales')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('store_id') storeId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.refunds.list(user.orgId, {
      storeId,
      limit: Math.min(Number(limit ?? 50) || 50, 200),
    });
  }

  /**
   * What of a sale can still be refunded.
   *
   * The register calls this before offering a refund, so a cashier is told
   * "only 1 of 3 left" before they promise a customer anything, rather than
   * after.
   */
  @Get('for-sale/:saleId')
  @RequirePermissions('refund.create')
  refundable(@CurrentUser() user: AuthenticatedUser, @Param('saleId') saleId: string) {
    return this.refunds.refundableLines(user.orgId, saleId);
  }
}
