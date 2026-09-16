import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { reorderProductImagesSchema, uploadProductImageSchema } from '@snappos/contracts';
import { ProductImagesService } from './product-images.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/** The shape `@fastify/multipart` adds to the request -- same narrow view `InvoicingController` takes of it. */
interface MultipartRequest {
  parts(): AsyncIterableIterator<
    | { type: 'file'; fieldname: string; mimetype: string; toBuffer(): Promise<Buffer> }
    | { type: 'field'; fieldname: string; value: unknown }
  >;
}

interface ImageResponse {
  header(name: string, value: string): void;
  send(body: Buffer): void;
}

@Controller({ path: 'catalog/images', version: '1' })
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  /**
   * Serve the bytes.
   *
   * Only `product.view`, because a photo of a thing on the shelf is the least
   * sensitive fact in the catalog -- and the register, which needs these, has
   * exactly that. The id names a row, never a storage key: see the service.
   */
  @Get(':id')
  @RequirePermissions('product.view')
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: ImageResponse,
    @Query('size') size?: string,
  ) {
    const { body, contentType } = await this.images.read(user.orgId, id, size === 'thumb' ? 'thumb' : 'full');
    res.header('Content-Type', contentType);
    // Immutable: an image row's bytes never change -- a replacement is a new
    // row with a new id -- so a register or a browser that has one can keep it
    // for as long as it likes. This is what makes an offline register's cached
    // photos stay valid.
    res.header('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(body);
  }

  /**
   * Upload one image, optionally with a thumbnail the client made.
   *
   * Multipart rather than JSON, and read part-by-part rather than with
   * `.file()`, because this accepts two files in one request: the display
   * image as `file` and an optional pre-scaled `thumb`. Sending them together
   * keeps a photo and its thumbnail from ever getting out of step.
   */
  @Post()
  @RequirePermissions('product.update')
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: unknown) {
    let file: { buffer: Buffer; contentType: string } | null = null;
    let thumb: { buffer: Buffer; contentType: string } | null = null;
    const fields: Record<string, string> = {};

    // Parts must be consumed in order and each buffered before the next
    // arrives; abandoning one mid-stream stalls the request.
    for await (const part of (req as MultipartRequest).parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.fieldname === 'thumb') thumb = { buffer, contentType: part.mimetype };
        else file = { buffer, contentType: part.mimetype };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!file) {
      throw new ApiException('validation_failed', 'an image file is required', { retryable: false });
    }

    const input = uploadProductImageSchema.parse(fields);
    return this.images.upload(user.orgId, user.userId, input, file, thumb ?? undefined);
  }

  @Post('reorder')
  @RequirePermissions('product.update')
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(reorderProductImagesSchema)) body: ReturnType<typeof reorderProductImagesSchema.parse>,
  ) {
    return this.images.reorder(user.orgId, user.userId, body.image_ids);
  }

  @Delete(':id')
  @RequirePermissions('product.update')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.images.remove(user.orgId, user.userId, id);
  }
}
