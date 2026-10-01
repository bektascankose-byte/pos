import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ReferenceController } from './reference.controller.js';
import { ReferenceService } from './reference.service.js';
import { ProductImagesController } from './product-images.controller.js';
import { ProductImagesService } from './product-images.service.js';
import { PosReleaseController } from './pos-release.controller.js';
import { PosReleaseService } from './pos-release.service.js';
import { StockImageService } from './stock-image.service.js';
import { BrandLogosController } from './brand-logos.controller.js';
import { BrandLogosService } from './brand-logos.service.js';
import { AiModule } from '../../platform/ai/ai.module.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';

@Module({
  imports: [AiModule, ObjectStorageModule],
  controllers: [
    CatalogController,
    ReferenceController,
    ProductImagesController,
    PosReleaseController,
    BrandLogosController,
  ],
  providers: [
    CatalogService,
    ReferenceService,
    ProductImagesService,
    PosReleaseService,
    StockImageService,
    BrandLogosService,
  ],
  exports: [CatalogService, ReferenceService, ProductImagesService, PosReleaseService],
})
export class CatalogModule {}
