import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service.js';
import { StorefrontController } from './storefront.controller.js';

/**
 * Everything the customer-facing site needs from the POS.
 *
 * Starts as availability only. Orders, carts and checkout land here in later
 * phases; keeping them in one module is what makes "the storefront's view of
 * the catalog" a single place to look rather than a concern smeared across
 * catalog, inventory and sales.
 */
@Module({
  controllers: [StorefrontController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class StorefrontModule {}
