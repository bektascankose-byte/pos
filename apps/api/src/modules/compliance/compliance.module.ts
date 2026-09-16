import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service.js';

/**
 * Exported, not controller-backed, for now.
 *
 * Nothing should call the compliance engine over HTTP: it is consulted by the
 * things that place orders, not by a client asking whether it may. The rule
 * management screens land with the back office in a later phase.
 */
@Module({
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
