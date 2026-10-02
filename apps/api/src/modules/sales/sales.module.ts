import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { ReceiptDeliveryService } from './receipt-delivery.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';

@Module({
  imports: [InventoryModule, LoyaltyModule],
  controllers: [SalesController],
  providers: [SalesService, ReceiptDeliveryService],
  exports: [SalesService],
})
export class SalesModule {}
