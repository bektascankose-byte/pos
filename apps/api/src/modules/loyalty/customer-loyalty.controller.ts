import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { loyaltyAdjustmentSchema } from '@snappos/contracts';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';
import { LoyaltyLedger } from './loyalty-ledger.service.js';

/** A customer's points, as the back office sees and corrects them. */
@Controller({ path: 'customers/:id/loyalty', version: '1' })
export class CustomerLoyaltyController {
  constructor(private readonly ledger: LoyaltyLedger) {}

  @Get()
  @RequirePermissions('customer.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.customerLoyalty(user.orgId, id);
  }

  @Post('adjustments')
  @RequirePermissions('loyalty.adjust')
  adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(loyaltyAdjustmentSchema)) body: ReturnType<typeof loyaltyAdjustmentSchema.parse>,
  ) {
    return this.ledger.adjust(user.orgId, user.userId, id, body.points, body.note);
  }
}
