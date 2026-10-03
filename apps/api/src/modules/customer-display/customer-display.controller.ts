import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  customerDisplayBirthdaySchema,
  customerDisplayIdentifySchema,
  customerDisplayJoinSchema,
  customerDisplayOffersSchema,
} from '@snappos/contracts';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';
import { CustomerDisplayService } from './customer-display.service.js';

/**
 * The customer facing screen at the counter.
 *
 * Every route here is `customer.view`, including the ones that write. That is
 * on purpose and it is not the cashier being trusted with more: the customer
 * is the one joining, giving a birthday or answering about offers, and the
 * service only lets each of those do the one narrow thing. Requiring
 * `customer.manage` would mean a shop's rewards sign up stopped working
 * whenever the person on shift was a plain cashier.
 *
 * The contact travels in the body even for the lookup. A phone number in a
 * query string ends up in access logs and proxies, which is a list of who
 * shops here that nobody meant to keep.
 */
@Controller({ path: 'customer-display', version: '1' })
export class CustomerDisplayController {
  constructor(private readonly display: CustomerDisplayService) {}

  @Post('identify')
  @HttpCode(200)
  @RequirePermissions('customer.view')
  identify(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(customerDisplayIdentifySchema)) body: ReturnType<typeof customerDisplayIdentifySchema.parse>,
  ) {
    return this.display.identify(user.orgId, body);
  }

  @Post('join')
  @HttpCode(200)
  @RequirePermissions('customer.view')
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(customerDisplayJoinSchema)) body: ReturnType<typeof customerDisplayJoinSchema.parse>,
  ) {
    return this.display.join(user.orgId, user.userId, user.storeId, body);
  }

  @Post('customers/:id/birthday')
  @HttpCode(200)
  @RequirePermissions('customer.view')
  birthday(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(customerDisplayBirthdaySchema)) body: ReturnType<typeof customerDisplayBirthdaySchema.parse>,
  ) {
    return this.display.setBirthday(user.orgId, user.userId, id, body);
  }

  @Post('customers/:id/offers')
  @HttpCode(200)
  @RequirePermissions('customer.view')
  offers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(customerDisplayOffersSchema)) body: ReturnType<typeof customerDisplayOffersSchema.parse>,
  ) {
    return this.display.setOffers(user.orgId, user.userId, id, body);
  }
}
