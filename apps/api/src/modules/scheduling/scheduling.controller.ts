import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { shiftQuerySchema, createShiftSchema, updateShiftSchema } from '@snappos/contracts';
import { SchedulingService } from './scheduling.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'scheduling', version: '1' })
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get('shifts')
  @RequirePermissions('schedule.view')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.scheduling.list(user.orgId, shiftQuerySchema.parse(query));
  }

  @Post('shifts')
  @RequirePermissions('schedule.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createShiftSchema)) body: ReturnType<typeof createShiftSchema.parse>,
  ) {
    return this.scheduling.create(user.orgId, user.userId, body);
  }

  @Patch('shifts/:id')
  @RequirePermissions('schedule.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateShiftSchema)) body: ReturnType<typeof updateShiftSchema.parse>,
  ) {
    return this.scheduling.update(user.orgId, user.userId, id, body);
  }

  @Post('shifts/:id/cancel')
  @RequirePermissions('schedule.manage')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.scheduling.cancel(user.orgId, user.userId, id);
  }
}
