import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service.js';
import { ComplianceRulesService } from './compliance-rules.service.js';
import { ComplianceController } from './compliance.controller.js';

/**
 * The compliance engine, and the screens that manage its rules.
 *
 * The engine itself is exported rather than routed: it is consulted by the
 * things that place orders, inside their own transactions. The controller only
 * lists, adds and ends rules.
 */
@Module({
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceRulesService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
