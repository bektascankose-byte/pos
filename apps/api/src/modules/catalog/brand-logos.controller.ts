import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { findBrandLogoSchema } from '@snappos/contracts';
import { BrandLogosService } from './brand-logos.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

/** The narrow view of `@fastify/multipart` the image upload already takes. */
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

/** Where a found logo came from: an http(s) address of sensible length, or nothing. */
function httpUrlOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

@Controller({ path: 'catalog', version: '1' })
export class BrandLogosController {
  constructor(private readonly logos: BrandLogosService) {}

  /** Brands with their logos, for the back office's Brands page. */
  @Get('brand-logos')
  @RequirePermissions('product.view')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.logos.list(user.orgId);
  }

  /**
   * The bytes, for the registers and the back office alike.
   *
   * `product.view`, which a register has, the same as a product photo.
   * Immutable: a replaced logo is a new row with a new id.
   */
  @Get('brand-logos/:id')
  @RequirePermissions('product.view')
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: ImageResponse) {
    const { body, contentType } = await this.logos.read(user.orgId, id);
    res.header('Content-Type', contentType);
    res.header('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(body);
  }

  /**
   * Where the brand's logo might be, found with AI. Addresses only; the back
   * office fetches, checks and uploads the one it keeps. See the service.
   *
   * `product.update`, because this makes the server read a website a model
   * named; everything about where that address may point is decided in
   * `StockImageService`.
   */
  @Post('brands/:id/logo/candidates')
  @HttpCode(200)
  @RequirePermissions('product.update')
  candidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(findBrandLogoSchema)) body: ReturnType<typeof findBrandLogoSchema.parse>,
  ) {
    return this.logos.candidates(user.orgId, id, body.replace);
  }

  /** A logo as multipart `file`, with the page it came from as `source_url` when it was found on the web. */
  @Post('brands/:id/logo')
  @RequirePermissions('product.update')
  async upload(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: unknown) {
    let file: { buffer: Buffer; contentType: string } | null = null;
    let sourceUrl: string | null = null;
    for await (const part of (req as MultipartRequest).parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.fieldname === 'file') file = { buffer, contentType: part.mimetype };
      } else if (part.fieldname === 'source_url') {
        sourceUrl = httpUrlOrNull(String(part.value));
      }
    }
    if (!file) {
      throw new ApiException('validation_failed', 'a logo file is required', { retryable: false });
    }
    return this.logos.upload(user.orgId, user.userId, id, file, sourceUrl);
  }

  @Delete('brands/:id/logo')
  @RequirePermissions('product.update')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.logos.remove(user.orgId, user.userId, id);
  }
}
