import { Controller, Get, Query } from '@nestjs/common';
import {
  salesSummaryQuerySchema,
  reportRangeQuerySchema,
  topProductsQuerySchema,
} from '@snappos/contracts';
import { ReportsService } from './reports.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * The dashboard's own read. Gated on `report.sales` like everything else
   * here: it summarizes the state of the business across catalog, inventory
   * and purchasing, which is the same audience the sales reports are for.
   */
  @Get('needs-attention')
  @RequirePermissions('report.sales')
  needsAttention(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.reports.needsAttention(user.orgId, storeId ?? null);
  }

  @Get('sales/summary')
  @RequirePermissions('report.sales')
  salesSummary(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.salesSummary(user.orgId, salesSummaryQuerySchema.parse(query));
  }

  @Get('sales/trend')
  @RequirePermissions('report.sales')
  salesTrend(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.salesTrend(user.orgId, reportRangeQuerySchema.parse(query));
  }

  @Get('sales/top-products')
  @RequirePermissions('report.sales')
  topProducts(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.topProducts(user.orgId, topProductsQuerySchema.parse(query));
  }

  @Get('sales/by-cashier')
  @RequirePermissions('report.sales')
  byCashier(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.byCashier(user.orgId, reportRangeQuerySchema.parse(query));
  }

  @Get('sales/by-payment-method')
  @RequirePermissions('report.sales')
  byPaymentMethod(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.byPaymentMethod(user.orgId, reportRangeQuerySchema.parse(query));
  }
}
