import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { createBannerFieldsSchema, updateBannerSchema } from '@snappos/contracts';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';
import { BannersService, type BannerMediaKind } from './banners.service.js';
import { sendMedia } from './shop.controllers.js';

/** The narrow view of `@fastify/multipart` this needs, the same one product photos take. */
interface MultipartRequest {
  parts(): AsyncIterableIterator<
    | { type: 'file'; fieldname: string; mimetype: string; toBuffer(): Promise<Buffer> }
    | { type: 'field'; fieldname: string; value: unknown }
  >;
}

type File = { buffer: Buffer; contentType: string };

async function readParts(req: unknown): Promise<{ files: Map<string, File>; fields: Record<string, string> }> {
  const files = new Map<string, File>();
  const fields: Record<string, string> = {};
  // Parts must be consumed in order and each buffered before the next arrives.
  for await (const part of (req as MultipartRequest).parts()) {
    if (part.type === 'file') files.set(part.fieldname, { buffer: await part.toBuffer(), contentType: part.mimetype });
    else fields[part.fieldname] = String(part.value);
  }
  return { files, fields };
}

/** Website banners, as the back office manages them. */
@Controller({ path: 'storefront/banners', version: '1' })
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  @RequirePermissions('storefront.view')
  list(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    if (!storeId || !z.string().uuid().safeParse(storeId).success) {
      throw new ApiException('validation_failed', 'store_id is required', { retryable: false });
    }
    return this.banners.list(user.orgId, storeId);
  }

  /** A new banner: the wide picture as `image`, an optional taller one for phones as `mobile_image`. */
  @Post()
  @RequirePermissions('storefront.manage')
  async create(@CurrentUser() user: AuthenticatedUser, @Req() req: unknown) {
    const { files, fields } = await readParts(req);
    const image = files.get('image');
    if (!image) throw new ApiException('validation_failed', 'a banner image is required', { retryable: false });
    const parsed = createBannerFieldsSchema.parse(fields);
    return this.banners.create(user.orgId, user.userId, parsed, image, files.get('mobile_image') ?? null);
  }

  @Post(':id/video')
  @RequirePermissions('storefront.manage')
  async attachVideo(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: unknown) {
    const { files } = await readParts(req);
    const video = files.get('video');
    if (!video) throw new ApiException('validation_failed', 'a video file is required', { retryable: false });
    return this.banners.attachVideo(user.orgId, user.userId, id, video);
  }

  @Patch(':id')
  @RequirePermissions('storefront.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateBannerSchema)) body: ReturnType<typeof updateBannerSchema.parse>,
  ) {
    return this.banners.update(user.orgId, user.userId, id, body);
  }

  @Delete(':id')
  @RequirePermissions('storefront.manage')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.banners.archive(user.orgId, user.userId, id);
  }

  @Get(':id/media/:kind')
  @RequirePermissions('storefront.view')
  async media(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Res() res: Parameters<typeof sendMedia>[0],
    @Headers('range') range?: string,
  ) {
    if (!['image', 'mobile', 'video'].includes(kind)) throw ApiException.notFound('banner media');
    sendMedia(res, await this.banners.staffMedia(user.orgId, id, kind as BannerMediaKind, range));
  }
}
