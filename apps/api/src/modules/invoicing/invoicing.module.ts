import { Module } from '@nestjs/common';
import { InvoicingController } from './invoicing.controller.js';
import { InvoicingService } from './invoicing.service.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';

@Module({
  imports: [ObjectStorageModule],
  controllers: [InvoicingController],
  providers: [InvoicingService],
})
export class InvoicingModule {}
