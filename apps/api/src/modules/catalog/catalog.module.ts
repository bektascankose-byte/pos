import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ReferenceController } from './reference.controller.js';
import { ReferenceService } from './reference.service.js';
import { AiModule } from '../../platform/ai/ai.module.js';

@Module({
  imports: [AiModule],
  controllers: [CatalogController, ReferenceController],
  providers: [CatalogService, ReferenceService],
  exports: [CatalogService, ReferenceService],
})
export class CatalogModule {}
