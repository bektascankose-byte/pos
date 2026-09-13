import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { createInvoiceImportSchema } from '@snappos/contracts';
import { InvoicingService } from './invoicing.service.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
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
  constructor(private readonly invoicing: InvoicingService) {}

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
}
