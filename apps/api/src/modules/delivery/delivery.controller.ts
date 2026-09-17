import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { simulateCourierEventSchema, updateDeliverySettingsSchema } from '@snappos/contracts';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';
import { DeliveryService } from './delivery.service.js';
import { DeliverySettingsService } from './delivery-settings.service.js';

const cancelCourierSchema = z.object({ reason: z.string().trim().min(3).max(300) });

function requireStore(storeId: string | undefined): string {
  if (!storeId || !z.string().uuid().safeParse(storeId).success) {
    throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
  }
  return storeId;
}

/** Delivery, from the back office: where the shop delivers, and sending orders out. */
@Controller({ path: 'delivery/settings', version: '1' })
export class DeliverySettingsController {
  constructor(private readonly settings: DeliverySettingsService) {}

  @Get()
  @RequirePermissions('storefront.view')
  get(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.settings.get(user.orgId, requireStore(storeId));
  }

  @Patch()
  @RequirePermissions('delivery.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(updateDeliverySettingsSchema)) body: ReturnType<typeof updateDeliverySettingsSchema.parse>,
    @Query('store_id') storeId?: string,
  ) {
    return this.settings.update(user.orgId, user.userId, requireStore(storeId), body);
  }
}

@Controller({ path: 'orders/:id', version: '1' })
export class DeliveryOrdersController {
  constructor(private readonly delivery: DeliveryService) {}

  /** The bag is packed: book a driver. */
  @Post('dispatch')
  @RequirePermissions('order.dispatch')
  dispatch(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.dispatch(user.orgId, user.userId, id);
  }

  @Post('courier/cancel')
  @RequirePermissions('order.dispatch')
  cancelCourier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelCourierSchema)) body: ReturnType<typeof cancelCourierSchema.parse>,
  ) {
    return this.delivery.cancelCourier(user.orgId, user.userId, id, body.reason);
  }

  /** A courier report typed in by hand. Only for simulated deliveries; see `DeliveryService.simulate`. */
  @Post('courier-reports')
  @RequirePermissions('order.dispatch')
  simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(simulateCourierEventSchema)) body: ReturnType<typeof simulateCourierEventSchema.parse>,
  ) {
    return this.delivery.simulate(user.orgId, user.userId, id, body.event);
  }
}
