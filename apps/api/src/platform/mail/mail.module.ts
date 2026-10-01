import { Global, Module } from '@nestjs/common';
import { MailerService } from './mailer.service.js';

/** Global for the same reason the database module is: anything may need to send. */
@Global()
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailModule {}
