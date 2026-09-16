import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AvailabilityService, type Fulfilment } from './availability.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

const fulfilmentSchema = z.enum(['pickup', 'delivery']);

const setListingSchema = z.object({
  availability: z.enum(['hidden', 'pickup_only', 'delivery_only', 'pickup_and_delivery']).optional(),
  safety_stock: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  max_per_order: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  online_price_minor: z.string().regex(/^\d+$/).optional(),
  hold_for_pickup: z.boolean().optional(),
  hold_for_delivery: z.boolean().optional(),
});

const checkSchema = z.object({
  store_id: z.string().uuid(),
  fulfilment: fulfilmentSchema,
  lines: z
    .array(z.object({ variant_id: z.string().uuid(), quantity: z.string().regex(/^\d+(\.\d{1,3})?$/) }))
    .min(1)
    .max(200),
});

/**
 * Staff-facing for now.
 *
 * These endpoints answer "what may the website sell" and are read by the
 * storefront through a service token, not by a customer's browser. The public,
 * unauthenticated catalog routes arrive with the storefront itself in phase 5;
 * shipping them before anything consumes them would mean an open endpoint
 * nobody is watching.
 */
@Controller({ path: 'storefront', version: '1' })
export class StorefrontController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('availability')
  @RequirePermissions('storefront.view')
  listing(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    const storeId = query.store_id;
    if (!storeId) {
      throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
    }
    const fulfilment = query.fulfilment
      ? (fulfilmentSchema.parse(query.fulfilment) as Fulfilment)
      : undefined;
    return this.availability.listing(user.orgId, storeId, fulfilment);
  }

  @Get('availability/:variantId')
  @RequirePermissions('storefront.view')
  async forVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
    @Query('store_id') storeId: string,
  ) {
    if (!storeId) {
      throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
    }
    const row = await this.availability.forVariant(user.orgId, storeId, variantId);
    if (!row) throw ApiException.notFound('listing');
    return row;
  }

  /**
   * Revalidate a cart. Returns `{ ok, problems }` rather than throwing on a
   * problem: a cart with three issues is one answer to render, not three
   * errors to catch.
   */
  @Post('availability/check')
  @RequirePermissions('storefront.view')
  async check(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(checkSchema)) body: ReturnType<typeof checkSchema.parse>,
  ) {
    const problems = await this.availability.check(
      user.orgId,
      body.store_id,
      body.fulfilment,
      body.lines.map((line) => ({ variantId: line.variant_id, quantity: line.quantity })),
    );
    return { ok: problems.length === 0, problems };
  }

  @Post('listings/:variantId')
  @RequirePermissions('storefront.manage')
  setListing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
    @Body(zodBody(setListingSchema)) body: ReturnType<typeof setListingSchema.parse>,
  ) {
    return this.availability.setListing(user.orgId, user.userId, variantId, body);
  }

  @Get('reconcile')
  @RequirePermissions('storefront.view')
  reconcile(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId: string) {
    if (!storeId) {
      throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
    }
    return this.availability.reconcile(user.orgId, storeId);
  }
}
