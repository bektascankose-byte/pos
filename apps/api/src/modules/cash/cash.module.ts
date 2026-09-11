import { Module } from '@nestjs/common';
import { CashController } from './cash.controller.js';
import { CashService } from './cash.service.js';

@Module({
  controllers: [CashController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
