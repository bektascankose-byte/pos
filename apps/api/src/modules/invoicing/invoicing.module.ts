import { Module } from '@nestjs/common';
import { InvoicingController } from './invoicing.controller.js';
import { InvoicingService } from './invoicing.service.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';
import { AiModule } from '../../platform/ai/ai.module.js';

@Module({
  imports: [ObjectStorageModule, AiModule],
  controllers: [InvoicingController],
  providers: [InvoicingService],
})
export class InvoicingModule {}
