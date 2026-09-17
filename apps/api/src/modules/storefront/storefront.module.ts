import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';
import { StorefrontClientsService } from './storefront-clients.service.js';
import { StorefrontController } from './storefront.controller.js';

/**
 * The back office's view of the website: which items are listed and how many
 * may be sold, and the keys the storefront server uses.
 *
 * The website's own routes live in `modules/shop`, which reads availability
 * from here -- so what staff set on an item page and what a shopper sees are
 * the same rows.
 */
@Module({
  controllers: [StorefrontController],
  providers: [AvailabilityService, StorefrontClientsService],
  exports: [AvailabilityService],
})
export class StorefrontModule {}
