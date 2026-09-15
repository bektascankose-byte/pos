import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createReceivingSessionSchema,
  bulkScanSchema,
  addReceivingLineSchema,
  updateReceivingLineSchema,
  createProductForScanSchema,
} from '@snappos/contracts';
import { z } from 'zod';
import { ReceivingService } from './receiving.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

const matchInvoiceSchema = z.object({ invoice_import_id: z.string().uuid() });

@Controller({ path: 'receiving', version: '1' })
export class ReceivingController {
  constructor(
    private readonly receiving: ReceivingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @RequirePermissions('purchasing.view')
  list(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.receiving.list(user.orgId, storeId);
  }

  @Get(':id')
  @RequirePermissions('purchasing.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.receiving.get(user.orgId, id);
  }

  @Post()
  @RequirePermissions('purchasing.create')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createReceivingSessionSchema)) body: ReturnType<typeof createReceivingSessionSchema.parse>,
  ) {
    return this.receiving.create(user.orgId, user.userId, body);
  }

  /** A whole box at once: one code per line. Repeats count, they don't collide. */
  @Post(':id/scan')
  @RequirePermissions('purchasing.create')
  bulkScan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(bulkScanSchema)) body: ReturnType<typeof bulkScanSchema.parse>,
  ) {
    return this.receiving.bulkScan(user.orgId, user.userId, id, body.codes);
  }

  @Post(':id/lines')
  @RequirePermissions('purchasing.create')
  addLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(addReceivingLineSchema)) body: ReturnType<typeof addReceivingLineSchema.parse>,
  ) {
    return this.receiving.addLine(user.orgId, user.userId, id, body);
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions('purchasing.create')
  updateLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(zodBody(updateReceivingLineSchema)) body: ReturnType<typeof updateReceivingLineSchema.parse>,
  ) {
    return this.receiving.updateLine(user.orgId, id, lineId, body);
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions('purchasing.create')
  removeLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ) {
    return this.receiving.removeLine(user.orgId, id, lineId);
  }

  /** Create a product from a scan that matched nothing, and point the line at it. */
  @Post(':id/lines/:lineId/create-product')
  @RequirePermissions('product.create')
  createProductForLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(zodBody(createProductForScanSchema)) body: ReturnType<typeof createProductForScanSchema.parse>,
  ) {
    return this.receiving.createProductForLine(user.orgId, user.userId, id, lineId, body);
  }

  /**
   * Compare a parsed invoice with what was counted. Reads only — it records
   * which invoice this delivery belongs to and reports the differences;
   * nothing about the stock or the invoice changes.
   */
  @Post(':id/match-invoice')
  @RequirePermissions('purchasing.create')
  matchInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(matchInvoiceSchema)) body: ReturnType<typeof matchInvoiceSchema.parse>,
  ) {
    return this.receiving.matchInvoice(user.orgId, user.userId, id, body.invoice_import_id);
  }

  /**
   * Put the delivery into stock. Requires an Idempotency-Key for the same
   * reason every other stock-moving endpoint does: a retried request without
   * one would receive the same box twice.
   */
  @Post(':id/commit')
  @RequirePermissions('purchasing.receive')
  async commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key) {
      throw new ApiException(
        'validation_failed',
        'POST /v1/receiving/:id/commit requires an Idempotency-Key header',
        { retryable: false },
      );
    }

    const outcome = await this.idempotency.execute(
      user.orgId,
      key,
      'POST /v1/receiving/:id/commit',
      { id },
      async () => ({ status: 200, body: await this.receiving.commit(user.orgId, user.userId, id) }),
    );
    return outcome.body;
  }

  @Post(':id/cancel')
  @RequirePermissions('purchasing.create')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.receiving.cancel(user.orgId, user.userId, id);
  }
}
