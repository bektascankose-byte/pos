import { Module } from '@nestjs/common';
import { ReceivingController } from './receiving.controller.js';
import { ReceivingService } from './receiving.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';

@Module({
  imports: [CatalogModule, InventoryModule],
  controllers: [ReceivingController],
  providers: [ReceivingService],
})
export class ReceivingModule {}
