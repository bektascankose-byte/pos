import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AuditController } from './audit.controller.js';

/** Global: nearly every module records something. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
