import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller.js';
import { MarketingService } from './marketing.service.js';
import { MessagingModule } from '../../platform/messaging/messaging.module.js';

@Module({
  imports: [MessagingModule],
  controllers: [MarketingController],
  providers: [MarketingService],
})
export class MarketingModule {}
