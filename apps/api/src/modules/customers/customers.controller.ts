import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createCustomerSchema,
  customerSearchSchema,
  updateCustomerSchema,
  setConsentSchema,
} from '@snappos/contracts';
import { CustomersService } from './customers.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  /** The register's normal path: a phone lookup, or a name/email fallback. */
  @Get()
  @RequirePermissions('customer.view')
  search(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.customers.search(user.orgId, customerSearchSchema.parse(query));
  }

  @Get(':id')
  @RequirePermissions('customer.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customers.get(user.orgId, id);
  }

  @Post()
  @RequirePermissions('customer.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createCustomerSchema)) body: ReturnType<typeof createCustomerSchema.parse>,
  ) {
    return this.customers.create(user.orgId, user.userId, body);
  }

  @Patch(':id')
  @RequirePermissions('customer.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateCustomerSchema)) body: ReturnType<typeof updateCustomerSchema.parse>,
  ) {
    return this.customers.update(user.orgId, user.userId, id, body);
  }

  /** What this customer is worth and what they buy, netted of refunds. */
  @Get(':id/history')
  @RequirePermissions('customer.view')
  history(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customers.history(user.orgId, id);
  }

  @Get(':id/consents')
  @RequirePermissions('customer.view')
  consents(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customers.consents(user.orgId, id);
  }

  @Get(':id/consents/history')
  @RequirePermissions('customer.view')
  consentHistory(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customers.consentHistory(user.orgId, id);
  }

  /**
   * Record a marketing opt-in or opt-out. Appends to the consent log; nothing
   * here ever edits or removes an earlier event.
   */
  @Post(':id/consents')
  @RequirePermissions('customer.manage')
  setConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(setConsentSchema)) body: ReturnType<typeof setConsentSchema.parse>,
  ) {
    return this.customers.setConsent(user.orgId, user.userId, id, body);
  }
}
