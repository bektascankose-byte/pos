import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { promoteReferenceSchema, referenceSearchSchema } from '@snappos/contracts';
import { ReferenceService } from './reference.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/**
 * Reading the reference catalog needs only `product.view` -- it is a lookup
 * table of facts about things, and knowing what a barcode is has never been
 * sensitive. Promoting a row creates a real product, so that one needs
 * `product.create` like any other way of creating one.
 */
@Controller({ path: 'reference', version: '1' })
export class ReferenceController {
  constructor(private readonly reference: ReferenceService) {}

  @Get('lookup/:code')
  @RequirePermissions('product.view')
  lookup(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.reference.lookup(user.orgId, code);
  }

  @Get('search')
  @RequirePermissions('product.view')
  search(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    const input = referenceSearchSchema.parse(query);
    return this.reference.search(user.orgId, input.q, input.limit);
  }

  @Get('stats')
  @RequirePermissions('product.view')
  stats(@CurrentUser() user: AuthenticatedUser) {
    return this.reference.stats(user.orgId);
  }

  @Post(':id/promote')
  @RequirePermissions('product.create')
  promote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(promoteReferenceSchema)) body: ReturnType<typeof promoteReferenceSchema.parse>,
    @Query('store_id') storeId?: string,
  ) {
    // Keys are added only when present rather than spread: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent field, and the service reads "absent" as "keep what the
    // reference row already says".
    return this.reference.promote(user.orgId, user.userId, storeId ?? user.storeId, id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.category_id === undefined ? {} : { category_id: body.category_id }),
      ...(body.brand_id === undefined ? {} : { brand_id: body.brand_id }),
      ...(body.price_minor === undefined ? {} : { price_minor: String(body.price_minor) }),
      ...(body.cost === undefined ? {} : { cost: body.cost }),
    });
  }
}
