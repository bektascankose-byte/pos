import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { saleQuerySchema, voidSaleSchema, sendReceiptSchema } from '@snappos/contracts';
import type { SendReceiptInput, SendReceiptResult } from '@snappos/contracts';
import { SalesService } from './sales.service.js';
import { ReceiptDeliveryService } from './receipt-delivery.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'sales', version: '1' })
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly receipts: ReceiptDeliveryService,
  ) {}

  @Get()
  @RequirePermissions('report.sales')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    const params = saleQuerySchema.parse(query);
    return this.sales.list(user.orgId, {
      storeId: params.store_id,
      registerId: params.register_id,
      cashierUserId: params.cashier_user_id,
      status: params.status,
      from: params.from,
      to: params.to,
      limit: params.limit,
    });
  }

  /** A cashier can reprint or look up a sale they just rang, hence sale.reprint. */
  @Get(':id')
  @RequirePermissions('sale.reprint')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.sales.findOne(user.orgId, id);
  }

  /**
   * Void a sale. A new state, never a deletion.
   *
   * Note there is no POST /sales: a sale is created by the register and arrives
   * through /sync/batch. There is deliberately no way to ring a sale over HTTP,
   * because a sale that depends on the network is a sale that cannot happen
   * when the internet is down.
   */
  @Post(':id/void')
  @RequirePermissions('sale.void')
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(voidSaleSchema)) body: { reason: string },
  ) {
    return this.sales.void(user.orgId, id, user.userId, body.reason);
  }

  /**
   * Send the customer their receipt.
   *
   * `sale.reprint` rather than a permission of its own: handing someone a
   * second copy of their own receipt is the same act whether it comes out of
   * the printer or arrives in their inbox, and a cashier who may do one has
   * no reason to be stopped from doing the other.
   */
  @Post(':id/receipt')
  @RequirePermissions('sale.reprint')
  sendReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(sendReceiptSchema)) body: SendReceiptInput,
  ): Promise<SendReceiptResult> {
    return this.receipts.send(user.orgId, id, user.userId, body);
  }

  /** Where this receipt has been sent, so "I never got it" is answerable. */
  @Get(':id/receipt-deliveries')
  @RequirePermissions('sale.reprint')
  receiptDeliveries(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.receipts.history(user.orgId, id);
  }
}
