import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { CustomerDisplayController } from './customer-display.controller.js';
import { CustomerDisplayService } from './customer-display.service.js';

/** The rewards sign in a customer does on the screen that faces them. */
@Module({
  imports: [LoyaltyModule],
  controllers: [CustomerDisplayController],
  providers: [CustomerDisplayService],
})
export class CustomerDisplayModule {}
