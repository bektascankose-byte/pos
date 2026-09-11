import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { RequirePermissions } from '../auth/auth.guard.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';

@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Read the audit trail.
   *
   * Gated on `audit.view` rather than folded into a general reporting
   * permission: the log records what every employee did, so the set of people
   * who may read it is deliberately smaller than the set who may run a sales
   * report.
   */
  @Get()
  @RequirePermissions('audit.view')
  query(@CurrentUser() user: AuthenticatedUser, @Query() q: Record<string, string>) {
    return this.audit.query(user.orgId, {
      entityType: q['entity_type'],
      entityId: q['entity_id'],
      actorUserId: q['actor_user_id'],
      action: q['action'],
      storeId: q['store_id'],
      limit: Math.min(Number(q['limit'] ?? 100) || 100, 500),
    });
  }
}
