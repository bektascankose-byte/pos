import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './platform/database/database.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { IdempotencyModule } from './platform/idempotency/idempotency.module.js';
import { AuthGuard } from './platform/auth/auth.guard.js';
import { ApiExceptionFilter } from './platform/errors/exception.filter.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { OrgModule } from './modules/org/org.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { RefundsModule } from './modules/refunds/refunds.module.js';
import { CashModule } from './modules/cash/cash.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { DataTransferModule } from './modules/data-transfer/data-transfer.module.js';
import { EmployeesModule } from './modules/employees/employees.module.js';
import { InvoicingModule } from './modules/invoicing/invoicing.module.js';
import { LoyaltyModule } from './modules/loyalty/loyalty.module.js';
import { OnboardingModule } from './modules/onboarding/onboarding.module.js';
import { PurchasingModule } from './modules/purchasing/purchasing.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { SchedulingModule } from './modules/scheduling/scheduling.module.js';
import { AuditModule } from './platform/audit/audit.module.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    IdempotencyModule,
    CatalogModule,
    InventoryModule,
    SalesModule,
    RefundsModule,
    CashModule,
    CustomersModule,
    DataTransferModule,
    EmployeesModule,
    InvoicingModule,
    LoyaltyModule,
    OnboardingModule,
    PurchasingModule,
    ReportsModule,
    SchedulingModule,
    SyncModule,
    OrgModule,
  ],
  controllers: [HealthController],
  providers: [
    // Authentication is global and opting out is an explicit @Public()
    // decorator. The reverse default eventually ships an unguarded endpoint.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
