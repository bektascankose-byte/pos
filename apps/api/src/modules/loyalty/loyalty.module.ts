import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller.js';
import { CustomerLoyaltyController } from './customer-loyalty.controller.js';
import { LoyaltyService } from './loyalty.service.js';
import { LoyaltyLedger } from './loyalty-ledger.service.js';

/**
 * The program's settings and its ledger. The ledger is exported because points
 * are earned and taken back inside other modules' transactions -- the sale
 * intake, voids and refunds -- rather than by a separate call afterwards.
 */
@Module({
  controllers: [LoyaltyController, CustomerLoyaltyController],
  providers: [LoyaltyService, LoyaltyLedger],
  exports: [LoyaltyLedger],
})
export class LoyaltyModule {}
