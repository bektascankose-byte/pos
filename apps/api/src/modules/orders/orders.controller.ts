import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { orderFulfilmentSchema } from '@snappos/contracts';
import { OrdersService } from './orders.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

const placeOrderSchema = z
  .object({
    store_id: z.string().uuid(),
    fulfilment: orderFulfilmentSchema,
    customer_id: z.string().uuid().optional(),
    guest_name: z.string().max(200).optional(),
    guest_email: z.string().email().max(320).optional(),
    guest_phone: z.string().max(32).optional(),
    lines: z
      .array(
        z.object({
          variant_id: z.string().uuid(),
          quantity: z.string().regex(/^\d+(\.\d{1,3})?$/),
        }),
      )
      .min(1)
      .max(100),
    pickup_from: z.string().datetime({ offset: true }).optional(),
    pickup_to: z.string().datetime({ offset: true }).optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => v.customer_id || v.guest_email || v.guest_phone, {
    message: 'an order needs a customer, or a guest email or phone to reach them on',
  });

const transitionSchema = z.object({ reason: z.string().max(500).optional() });
/**
 * Completing takes a tender, because a finished sale has to record how it was
 * paid, and -- when any line is age restricted -- confirmation that whoever is
 * handing it over looked at the customer's photo ID.
 */
const completeSchema = z.object({
  tender: z.enum(['cash', 'card', 'other']),
  id_checked: z.boolean().optional(),
});
const removeLineSchema = z.object({ reason: z.string().min(1).max(500) });

/**
 * Staff-facing.
 *
 * Customers place orders through the shop routes (`modules/shop`), which work
 * from a cart and are authenticated by the storefront's own key. This
 * controller is the back office: the queue, and every step staff take with an
 * order once it exists.
 */
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('order.view')
  queue(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId: string) {
    if (!storeId) {
      throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
    }
    return this.orders.queue(user.orgId, storeId);
  }

  @Get(':id')
  @RequirePermissions('order.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.get(user.orgId, id);
  }

  @Post()
  @RequirePermissions('order.manage')
  place(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(placeOrderSchema)) body: ReturnType<typeof placeOrderSchema.parse>,
  ) {
    return this.orders.place(user.orgId, body);
  }

  @Post(':id/accept')
  @RequirePermissions('order.manage')
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.transition(user.orgId, user.userId, id, 'accepted');
  }

  @Post(':id/preparing')
  @RequirePermissions('order.manage')
  preparing(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.transition(user.orgId, user.userId, id, 'preparing');
  }

  @Post(':id/ready')
  @RequirePermissions('order.manage')
  ready(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.transition(user.orgId, user.userId, id, 'ready');
  }

  /**
   * Handover. The only call here that moves stock, and the one that writes the
   * sale. Retrying it is safe: the order is locked for the whole transition and
   * a completed order cannot complete again.
   */
  @Post(':id/complete')
  @RequirePermissions('order.manage')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(completeSchema)) body: ReturnType<typeof completeSchema.parse>,
  ) {
    return this.orders.transition(user.orgId, user.userId, id, 'completed', {
      tender: body.tender,
      idChecked: body.id_checked,
    });
  }

  @Post(':id/reject')
  @RequirePermissions('order.manage')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(transitionSchema)) body: ReturnType<typeof transitionSchema.parse>,
  ) {
    return this.orders.transition(user.orgId, user.userId, id, 'rejected', { reason: body.reason });
  }

  @Post(':id/cancel')
  @RequirePermissions('order.cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(transitionSchema)) body: ReturnType<typeof transitionSchema.parse>,
  ) {
    return this.orders.transition(user.orgId, user.userId, id, 'cancelled', { reason: body.reason });
  }

  @Post(':id/lines/:lineId/remove')
  @RequirePermissions('order.manage')
  removeLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(zodBody(removeLineSchema)) body: ReturnType<typeof removeLineSchema.parse>,
  ) {
    return this.orders.removeLine(user.orgId, user.userId, id, lineId, body.reason);
  }
}
