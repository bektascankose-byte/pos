import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  openCashSessionSchema,
  closeCashSessionSchema,
  postCashMovementSchema,
} from '@snappos/contracts';
import { CashService } from './cash.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'cash', version: '1' })
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Post('sessions')
  @RequirePermissions('cash.session_open')
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(openCashSessionSchema)) body: ReturnType<typeof openCashSessionSchema.parse>,
  ) {
    return this.cash.open(user.orgId, user.userId, {
      register_id: body.register_id,
      opening_float_minor: body.opening_float_minor,
      blind: body.blind,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }

  /**
   * Close against a counted amount.
   *
   * Closing is a manager action even though opening is not. Opening a drawer
   * commits nothing; closing one produces the over/short number that a shift is
   * judged by, and letting the person who is short report their own variance
   * removes the only check on it.
   */
  @Post('sessions/:id/close')
  @RequirePermissions('cash.session_close')
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(closeCashSessionSchema)) body: ReturnType<typeof closeCashSessionSchema.parse>,
  ) {
    return this.cash.close(user.orgId, user.userId, id, {
      counted_minor: body.counted_minor,
      ...(body.denominations !== undefined ? { denominations: body.denominations } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }

  @Get('sessions/:id')
  @RequirePermissions('cash.session_open')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.cash.status(user.orgId, id);
  }

  /** The open session for a register. The register asks on unlock. */
  @Get('sessions')
  @RequirePermissions('cash.session_open')
  openSession(@CurrentUser() user: AuthenticatedUser, @Query('register_id') registerId: string) {
    return this.cash.openSessionFor(user.orgId, registerId);
  }

  @Post('movements')
  @RequirePermissions('cash.paid_in_out')
  movement(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(postCashMovementSchema)) body: ReturnType<typeof postCashMovementSchema.parse>,
  ) {
    return this.cash.postMovement(user.orgId, user.userId, {
      session_id: body.session_id,
      kind: body.kind,
      amount_minor: body.amount_minor,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.approved_by !== undefined ? { approved_by: body.approved_by } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.occurred_at !== undefined ? { occurred_at: body.occurred_at } : {}),
    });
  }
}
