import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SalesModule } from '../sales/sales.module.js';
import { RefundsModule } from '../refunds/refunds.module.js';

@Module({
  imports: [SalesModule, RefundsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
