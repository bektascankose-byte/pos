import { Module } from '@nestjs/common';
import { InvoicingController } from './invoicing.controller.js';
import { InvoicingService } from './invoicing.service.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';
import { AiModule } from '../../platform/ai/ai.module.js';
import { PurchasingModule } from '../purchasing/purchasing.module.js';

@Module({
  imports: [ObjectStorageModule, AiModule, PurchasingModule],
  controllers: [InvoicingController],
  providers: [InvoicingService],
})
export class InvoicingModule {}
