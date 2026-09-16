import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ReferenceController } from './reference.controller.js';
import { ReferenceService } from './reference.service.js';
import { ProductImagesController } from './product-images.controller.js';
import { ProductImagesService } from './product-images.service.js';
import { AiModule } from '../../platform/ai/ai.module.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';

@Module({
  imports: [AiModule, ObjectStorageModule],
  controllers: [CatalogController, ReferenceController, ProductImagesController],
  providers: [CatalogService, ReferenceService, ProductImagesService],
  exports: [CatalogService, ReferenceService, ProductImagesService],
})
export class CatalogModule {}
