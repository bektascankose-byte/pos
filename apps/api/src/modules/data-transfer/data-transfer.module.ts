import { Module } from '@nestjs/common';
import { DataTransferController } from './data-transfer.controller.js';
import { DataTransferService } from './data-transfer.service.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';
import { AiModule } from '../../platform/ai/ai.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';

@Module({
  imports: [ObjectStorageModule, AiModule, CatalogModule],
  controllers: [DataTransferController],
  providers: [DataTransferService],
})
export class DataTransferModule {}
