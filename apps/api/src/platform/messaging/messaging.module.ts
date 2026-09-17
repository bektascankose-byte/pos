import { Module } from '@nestjs/common';
import { MessagingService } from './messaging.service.js';
import { TransactionalMailer } from './transactional-mailer.js';
import { TransactionalTexter } from './transactional-texter.js';

@Module({
  providers: [MessagingService, TransactionalMailer, TransactionalTexter],
  exports: [MessagingService, TransactionalMailer, TransactionalTexter],
})
export class MessagingModule {}
