import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { sendToPosSchema } from '@snappos/contracts';
import { PosReleaseService } from './pos-release.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/** Send to POS: what is waiting for the registers, and the button that sends it. */
@Controller({ path: 'catalog/pos-release', version: '1' })
export class PosReleaseController {
  constructor(private readonly releases: PosReleaseService) {}

  @Get('pending')
  @RequirePermissions('product.view')
  pending(@CurrentUser() user: AuthenticatedUser) {
    return this.releases.pending(user.orgId);
  }

  /** Sending changes what every register sells, so it takes the same right as editing the catalog. */
  @Post('send')
  @HttpCode(200)
  @RequirePermissions('product.update')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(sendToPosSchema)) body: ReturnType<typeof sendToPosSchema.parse>,
  ) {
    return this.releases.send(user.orgId, user.userId, body.product_ids);
  }
}
