import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { InventoryRepository } from './inventory.repository.js';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
  // Exported because sales, refunds and online orders all post stock through
  // the same repository. Nothing else is permitted to touch inventory_levels.
  exports: [InventoryService, InventoryRepository],
})
export class InventoryModule {}
