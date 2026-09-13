import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { createInvoiceImportSchema, resolveInvoiceLineSchema, splitInvoiceLineSchema } from '@snappos/contracts';
import { InvoicingService } from './invoicing.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/**
 * The slice of `@fastify/multipart`'s request augmentation this controller
 * actually uses, defined locally rather than relying on its ambient
 * `declare module 'fastify'` merge being visible from this file -- which in
 * practice was not, however `main.ts`'s own import of the package should, in
 * theory, have made it program wide.
 */
interface MultipartField {
  type: 'field' | 'file';
  value?: unknown;
}

interface MultipartRequestFile {
  toBuffer(): Promise<Buffer>;
  filename: string;
  mimetype: string;
  fields: Record<string, MultipartField | MultipartField[] | undefined>;
}

interface MultipartRequest {
  file(): Promise<MultipartRequestFile | undefined>;
}

/** What a vendor invoice can actually arrive as. Anything else is refused before it's ever stored. */
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/csv',
  'application/vnd.ms-excel', // some browsers label a .csv this way
  'text/plain', // a raw EDI document, the rare vendor who sends one
]);

@Controller({ path: 'invoice-imports', version: '1' })
export class InvoicingController {
  constructor(
    private readonly invoicing: InvoicingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @RequirePermissions('purchasing.view')
  list(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.invoicing.list(user.orgId, storeId);
  }

  @Get(':id')
  @RequirePermissions('purchasing.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoicing.get(user.orgId, id);
  }

  /**
   * Multipart, not JSON -- the file itself is a stream `@fastify/multipart`
   * reads directly off the request, which is why this reads `@Req()` rather
   * than a `@Body()` DTO the way every other write in this API does.
   */
  @Post()
  @RequirePermissions('purchasing.create')
  async create(@CurrentUser() user: AuthenticatedUser, @Req() req: unknown) {
    const data = await (req as MultipartRequest).file();
    if (!data) {
      throw new ApiException('validation_failed', 'a file is required', { retryable: false });
    }

    const buffer = await data.toBuffer();

    if (!ALLOWED_CONTENT_TYPES.has(data.mimetype)) {
      throw new ApiException(
        'validation_failed',
        `unsupported file type "${data.mimetype}" -- expected a PDF, PNG, JPG, CSV, or plain text (EDI) file`,
        { retryable: false },
      );
    }

    const fields: Record<string, string> = {};
    for (const [key, part] of Object.entries(data.fields)) {
      if (part && !Array.isArray(part) && part.type === 'field') {
        fields[key] = String(part.value);
      }
    }
    const input = createInvoiceImportSchema.parse(fields);

    return this.invoicing.create(user.orgId, user.userId, input, {
      buffer,
      filename: data.filename,
      contentType: data.mimetype,
    });
  }

  @Post(':id/parse')
  @RequirePermissions('purchasing.create')
  parse(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoicing.parse(user.orgId, id);
  }

  @Post(':id/match')
  @RequirePermissions('purchasing.create')
  match(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoicing.match(user.orgId, id);
  }

  @Post(':id/lines/:lineId/resolve')
  @RequirePermissions('purchasing.create')
  resolveLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(zodBody(resolveInvoiceLineSchema)) body: ReturnType<typeof resolveInvoiceLineSchema.parse>,
  ) {
    return this.invoicing.resolveLine(user.orgId, user.userId, id, lineId, body);
  }

  @Post(':id/lines/:lineId/ignore')
  @RequirePermissions('purchasing.create')
  ignoreLine(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Param('lineId') lineId: string) {
    return this.invoicing.ignoreLine(user.orgId, user.userId, id, lineId);
  }

  @Post(':id/lines/:lineId/split')
  @RequirePermissions('purchasing.create')
  splitLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body(zodBody(splitInvoiceLineSchema)) body: ReturnType<typeof splitInvoiceLineSchema.parse>,
  ) {
    return this.invoicing.splitLine(user.orgId, user.userId, id, lineId, body);
  }

  /**
   * The only place this whole system moves real stock or money. Requires an
   * Idempotency-Key for the same reason `purchase-orders/:id/receive`
   * does -- this posts inventory movements, and a retried request without
   * one would receive the same shipment twice.
   */
  @Post(':id/commit')
  @RequirePermissions('purchasing.create', 'purchasing.receive')
  async commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key) {
      throw new ApiException('validation_failed', 'POST /v1/invoice-imports/:id/commit requires an Idempotency-Key header', {
        retryable: false,
      });
    }

    const outcome = await this.idempotency.execute(
      user.orgId,
      key,
      'POST /v1/invoice-imports/:id/commit',
      { id },
      async () => ({ status: 200, body: await this.invoicing.commit(user.orgId, user.userId, id) }),
    );

    return outcome.body;
  }
}
