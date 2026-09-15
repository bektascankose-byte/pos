import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service.js';

@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
