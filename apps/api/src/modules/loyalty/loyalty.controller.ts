import { Body, Controller, Get, Patch } from '@nestjs/common';
import { updateLoyaltySettingsSchema } from '@snappos/contracts';
import { LoyaltyService } from './loyalty.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'loyalty/settings', version: '1' })
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  @RequirePermissions('loyalty.view')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.loyalty.get(user.orgId);
  }

  @Patch()
  @RequirePermissions('loyalty.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(updateLoyaltySettingsSchema)) body: ReturnType<typeof updateLoyaltySettingsSchema.parse>,
  ) {
    return this.loyalty.update(user.orgId, user.userId, body);
  }
}
