import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersController } from './orders.controller.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { SalesModule } from '../sales/sales.module.js';

/**
 * Orders sit deliberately downstream of availability, compliance and sales
 * rather than reimplementing any of them. Placing an order asks the first two
 * whether it may exist; completing one asks the third to record that it did.
 */
@Module({
  imports: [StorefrontModule, ComplianceModule, SalesModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
