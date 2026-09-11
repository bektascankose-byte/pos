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
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule, IdempotencyModule, CatalogModule, InventoryModule, SyncModule, OrgModule],
  controllers: [HealthController],
  providers: [
    // Authentication is global and opting out is an explicit @Public()
    // decorator. The reverse default eventually ships an unguarded endpoint.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
