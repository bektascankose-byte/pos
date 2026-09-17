import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  createComplianceRuleSchema,
  liftComplianceRuleSchema,
  withdrawComplianceRuleLiftSchema,
} from '@snappos/contracts';
import { ComplianceRulesService } from './compliance-rules.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

const endRuleSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Managing the rules, never asking them.
 *
 * Nothing here evaluates a rule for a cart. The engine is consulted by the
 * things that place orders, inside their own transactions -- a client asking
 * over HTTP whether it may sell something would be asking a question whose
 * answer could change before it acted on it.
 */
@Controller({ path: 'compliance/rules', version: '1' })
export class ComplianceController {
  constructor(private readonly rules: ComplianceRulesService) {}

  @Get()
  @RequirePermissions('compliance.view')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.rules.list(user.orgId);
  }

  @Post()
  @RequirePermissions('compliance.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createComplianceRuleSchema)) body: ReturnType<typeof createComplianceRuleSchema.parse>,
  ) {
    return this.rules.create(user.orgId, user.userId, body);
  }

  @Post(':id/end')
  @RequirePermissions('compliance.manage')
  end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(endRuleSchema)) body: ReturnType<typeof endRuleSchema.parse>,
  ) {
    if (!z.string().uuid().safeParse(id).success) throw ApiException.notFound('rule');
    return this.rules.end(user.orgId, user.userId, id, body.reason);
  }

  /**
   * Lift a platform rule for this shop, on record.
   *
   * Separate from `end` on purpose. Ending is for the shop's own rules and
   * needs only a reason; lifting takes a platform rule out of force here and
   * needs the legal review behind it, so the two cannot be confused for one
   * another in an audit log or in a hurry.
   */
  @Post(':id/lift')
  @RequirePermissions('compliance.manage')
  lift(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(liftComplianceRuleSchema)) body: ReturnType<typeof liftComplianceRuleSchema.parse>,
  ) {
    if (!z.string().uuid().safeParse(id).success) throw ApiException.notFound('rule');
    return this.rules.lift(user.orgId, user.userId, id, body);
  }

  @Post(':id/lift/withdraw')
  @RequirePermissions('compliance.manage')
  withdrawLift(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(withdrawComplianceRuleLiftSchema))
    body: ReturnType<typeof withdrawComplianceRuleLiftSchema.parse>,
  ) {
    if (!z.string().uuid().safeParse(id).success) throw ApiException.notFound('rule');
    return this.rules.withdrawLift(user.orgId, user.userId, id, body.reason);
  }
}
