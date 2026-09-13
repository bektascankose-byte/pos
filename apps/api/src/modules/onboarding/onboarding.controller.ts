import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createOnboardingTaskTemplateSchema,
  updateOnboardingTaskTemplateSchema,
  addOnboardingChecklistItemSchema,
} from '@snappos/contracts';
import { OnboardingService } from './onboarding.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('templates')
  @RequirePermissions('employee.view')
  listTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.listTemplates(user.orgId);
  }

  @Post('templates')
  @RequirePermissions('employee.manage')
  createTemplateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createOnboardingTaskTemplateSchema)) body: ReturnType<typeof createOnboardingTaskTemplateSchema.parse>,
  ) {
    return this.onboarding.createTemplateItem(user.orgId, user.userId, body);
  }

  @Patch('templates/:id')
  @RequirePermissions('employee.manage')
  updateTemplateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateOnboardingTaskTemplateSchema)) body: ReturnType<typeof updateOnboardingTaskTemplateSchema.parse>,
  ) {
    return this.onboarding.updateTemplateItem(user.orgId, user.userId, id, body);
  }

  @Get('checklists/:userId')
  @RequirePermissions('employee.view')
  getChecklist(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.onboarding.getChecklist(user.orgId, userId);
  }

  @Post('checklists/:userId/items')
  @RequirePermissions('employee.manage')
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body(zodBody(addOnboardingChecklistItemSchema)) body: ReturnType<typeof addOnboardingChecklistItemSchema.parse>,
  ) {
    return this.onboarding.addItem(user.orgId, user.userId, userId, body);
  }

  @Post('checklists/:userId/items/:itemId/complete')
  @RequirePermissions('employee.manage')
  completeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.onboarding.completeItem(user.orgId, user.userId, userId, itemId);
  }

  @Post('checklists/:userId/items/:itemId/reopen')
  @RequirePermissions('employee.manage')
  uncompleteItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.onboarding.uncompleteItem(user.orgId, user.userId, userId, itemId);
  }
}
