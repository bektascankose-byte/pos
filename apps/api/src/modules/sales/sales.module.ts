import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [InventoryModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
