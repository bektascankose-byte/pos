import { Module } from '@nestjs/common';
import { RefundsController } from './refunds.controller.js';
import { RefundsService } from './refunds.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [InventoryModule],
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
