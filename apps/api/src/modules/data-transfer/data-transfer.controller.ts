import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { importEntity, setImportMappingSchema, exportFormat } from '@snappos/contracts';
import { DataTransferService } from './data-transfer.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { writeCsv, writeXlsx } from '../../platform/tabular/tabular.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/** The slice of `@fastify/multipart`'s request augmentation used here -- see the same note in `InvoicingController`. */
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

/** The minimum of Fastify's reply this controller needs to send a file rather than JSON. */
interface FileReply {
  header(name: string, value: string): unknown;
  send(payload: Buffer): unknown;
}

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/**
 * What writing each entity actually requires. Not expressible with
 * `@RequirePermissions`, which ANDs its arguments -- listing both would make
 * a customer import demand catalog rights it never uses. These routes are
 * shared because they are keyed by a job id rather than an entity, so the
 * entity's own permission is checked once the job says what it is.
 *
 * Items take `product.bulk_update` rather than `product.update`: an import
 * rewrites prices and costs across the whole catalog in one action, which is
 * the thing that permission was written to gate.
 */
const WRITE_PERMISSION = {
  item: 'product.bulk_update',
  customer: 'customer.manage',
} as const;

function assertCanWrite(user: AuthenticatedUser, entity: 'item' | 'customer'): void {
  const required = WRITE_PERMISSION[entity];
  if (!user.permissions.includes(required)) throw ApiException.forbidden(required);
}

/**
 * Spreadsheets in and out.
 *
 * Import is three calls on purpose -- upload, dry run, commit -- and commit
 * carries no mapping of its own, so what runs is always what was reviewed.
 * See `DataTransferService` for why that matters more than the convenience of
 * a single call.
 */
@Controller({ path: 'data-transfer', version: '1' })
export class DataTransferController {
  constructor(private readonly dataTransfer: DataTransferService) {}

  // --- Import ---------------------------------------------------------------

  @Get('imports')
  @RequirePermissions('product.view')
  listImports(@CurrentUser() user: AuthenticatedUser, @Query('entity') entity?: string) {
    return this.dataTransfer.listImports(user.orgId, entity === 'customer' ? 'customer' : entity === 'item' ? 'item' : undefined);
  }

  @Get('imports/:id')
  @RequirePermissions('product.view')
  getImport(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.dataTransfer.getImport(user.orgId, id);
  }

  /**
   * Multipart, like the invoice upload -- the file is a stream
   * `@fastify/multipart` reads off the request, not something a Zod body can
   * describe.
   *
   * The entity's own write permission is checked here at upload rather than
   * only at commit, so someone who could never commit is told before they
   * spend time reviewing a mapping.
   */
  @Post('imports')
  @RequirePermissions('product.view')
  async createImport(@CurrentUser() user: AuthenticatedUser, @Req() req: unknown) {
    const data = await (req as MultipartRequest).file();
    if (!data) throw new ApiException('validation_failed', 'a file is required', { retryable: false });

    const buffer = await data.toBuffer();
    const fields: Record<string, string> = {};
    for (const [key, part] of Object.entries(data.fields)) {
      if (part && !Array.isArray(part) && part.type === 'field') fields[key] = String(part.value);
    }

    const entity = importEntity.safeParse(fields.entity);
    if (!entity.success) {
      throw new ApiException('validation_failed', 'entity must be "item" or "customer"', { retryable: false });
    }
    assertCanWrite(user, entity.data);

    return this.dataTransfer.createImport(
      user.orgId,
      user.userId,
      { entity: entity.data, store_id: fields.store_id || undefined },
      { buffer, filename: data.filename, contentType: data.mimetype },
    );
  }

  @Post('imports/:id/mapping')
  @RequirePermissions('product.view')
  async setMapping(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(setImportMappingSchema)) body: ReturnType<typeof setImportMappingSchema.parse>,
  ) {
    assertCanWrite(user, await this.entityOf(user, id));
    return this.dataTransfer.setMapping(user.orgId, user.userId, id, body);
  }

  /** Validates every row and reports what committing would do. Writes nothing. */
  @Post('imports/:id/dry-run')
  @RequirePermissions('product.view')
  async dryRun(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    assertCanWrite(user, await this.entityOf(user, id));
    return this.dataTransfer.dryRun(user.orgId, id);
  }

  /**
   * No Idempotency-Key, unlike the invoice commit: this is guarded by the
   * job's own status instead. A committed job is `committed`, and a second
   * commit is refused by that check, so a retried request cannot double-apply
   * an import the way it could double-receive a shipment.
   */
  @Post('imports/:id/commit')
  @RequirePermissions('product.view')
  async commitImport(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    assertCanWrite(user, await this.entityOf(user, id));
    return this.dataTransfer.commitImport(user.orgId, user.userId, id);
  }

  /** Which entity a job is for, so the right permission can be checked on a route keyed only by id. */
  private async entityOf(user: AuthenticatedUser, id: string): Promise<'item' | 'customer'> {
    const job = await this.dataTransfer.getImport(user.orgId, id);
    return job.entity;
  }

  // --- Export ---------------------------------------------------------------

  @Get('exports/items')
  @RequirePermissions('product.export')
  async exportItems(
    @CurrentUser() user: AuthenticatedUser,
    @Res() reply: FileReply,
    @Query('format') format?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    const chosen = exportFormat.catch('csv').parse(format);
    const { headers, rows } = await this.dataTransfer.exportItems(user.orgId, { q, status });
    await this.dataTransfer.recordExport(user.orgId, user.userId, 'product', rows.length, chosen);
    await this.sendFile(reply, chosen, 'items', headers, rows);
  }

  /**
   * `customer.export` has existed since the first migration and nothing has
   * used it until now. This is the route it was written for: the difference
   * between looking a customer up and walking out with the whole list.
   */
  @Get('exports/customers')
  @RequirePermissions('customer.export')
  async exportCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Res() reply: FileReply,
    @Query('format') format?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    const chosen = exportFormat.catch('csv').parse(format);
    const { headers, rows } = await this.dataTransfer.exportCustomers(user.orgId, { q, status });
    await this.dataTransfer.recordExport(user.orgId, user.userId, 'customer', rows.length, chosen);
    await this.sendFile(reply, chosen, 'customers', headers, rows);
  }

  private async sendFile(
    reply: FileReply,
    format: 'csv' | 'xlsx',
    name: string,
    headers: string[],
    rows: string[][],
  ) {
    const body = format === 'xlsx' ? await writeXlsx(name, headers, rows) : writeCsv(headers, rows);
    const filename = `${name}-${new Date().toISOString().slice(0, 10)}.${format}`;
    reply.header('content-type', CONTENT_TYPES[format]);
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.send(body);
  }
}
