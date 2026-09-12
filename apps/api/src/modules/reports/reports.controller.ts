import { Controller, Get, Query } from '@nestjs/common';
import { salesSummaryQuerySchema } from '@snappos/contracts';
import { ReportsService } from './reports.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales/summary')
  @RequirePermissions('report.sales')
  salesSummary(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.reports.salesSummary(user.orgId, salesSummaryQuerySchema.parse(query));
  }
}
