import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  bannerPlacementSchema,
  shopChangePasswordSchema,
  shopCheckoutSchema,
  shopConfirmPhoneCodeSchema,
  shopConsentsSchema,
  shopForgotPasswordSchema,
  shopRegisterSchema,
  shopRequestPhoneCodeSchema,
  shopResetPasswordSchema,
  shopSetCartLineSchema,
  shopSetFulfilmentSchema,
  shopSignInSchema,
  shopTokenSchema,
  shopUpdateProfileSchema,
  type OrderFulfilment,
} from '@snappos/contracts';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { ApiException } from '../../platform/errors/api-exception.js';
import { CurrentShop, ShopRoute, type ShopRequestContext } from '../../platform/shop/shop.guard.js';
import { BannersService, type BannerMediaKind } from './banners.service.js';
import { CartsService } from './carts.service.js';
import { CheckoutService } from './checkout.service.js';
import { CustomerAccountsService } from './customer-accounts.service.js';
import { CustomerSessions, CustomerToken } from './customer-sessions.service.js';
import { ShopCatalogService, type ProductSort } from './shop-catalog.service.js';

const uuidParam = z.string().uuid();
const SORTS: readonly ProductSort[] = ['featured', 'price_asc', 'price_desc', 'newest', 'name'];

function requireUuid(value: string, what: string): string {
  if (!uuidParam.safeParse(value).success) throw ApiException.notFound(what);
  return value;
}

/** Which catalog to show: what can be picked up, or what can be delivered. Pickup unless asked. */
function fulfilmentOf(value: string | undefined): OrderFulfilment {
  return value === 'delivery' ? 'delivery' : 'pickup';
}

interface MediaResponse {
  status(code: number): MediaResponse;
  header(name: string, value: string): void;
  send(body: Buffer): void;
}

/**
 * The website's catalog: what is for sale, the photos of it, and the brand
 * banners around it.
 *
 * Every route here answers the storefront server, never a browser directly --
 * see `ShopRoute`. None of them needs a signed-in customer.
 */
@Controller({ path: 'shop', version: '1' })
@ShopRoute()
export class ShopCatalogController {
  constructor(
    private readonly catalog: ShopCatalogService,
    private readonly banners: BannersService,
  ) {}

  @Get('info')
  info(@CurrentShop() shop: ShopRequestContext) {
    return this.catalog.info(shop);
  }

  @Get('categories')
  categories(@CurrentShop() shop: ShopRequestContext, @Query('fulfilment') fulfilment?: string) {
    return this.catalog.categories(shop, fulfilmentOf(fulfilment));
  }

  @Get('products')
  products(
    @CurrentShop() shop: ShopRequestContext,
    @Query('category') category?: string,
    @Query('brand') brand?: string,
    @Query('q') q?: string,
    @Query('in_stock') inStock?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('fulfilment') fulfilment?: string,
  ) {
    return this.catalog.products(
      shop,
      {
        category: category?.slice(0, 100) || undefined,
        brand: brand && uuidParam.safeParse(brand).success ? brand : undefined,
        q: q?.slice(0, 100) || undefined,
        inStock: inStock === 'true' || inStock === '1',
        sort: SORTS.includes(sort as ProductSort) ? (sort as ProductSort) : 'featured',
        page: Number.parseInt(page ?? '1', 10) || 1,
        pageSize: Number.parseInt(pageSize ?? '24', 10) || 24,
      },
      fulfilmentOf(fulfilment),
    );
  }

  @Get('products/:id')
  product(@CurrentShop() shop: ShopRequestContext, @Param('id') id: string, @Query('fulfilment') fulfilment?: string) {
    return this.catalog.product(shop, requireUuid(id, 'product'), fulfilmentOf(fulfilment));
  }

  @Get('brands/:id')
  brand(@CurrentShop() shop: ShopRequestContext, @Param('id') id: string, @Query('fulfilment') fulfilment?: string) {
    return this.catalog.brand(shop, requireUuid(id, 'brand'), fulfilmentOf(fulfilment));
  }

  @Get('suggest')
  suggest(@CurrentShop() shop: ShopRequestContext, @Query('q') q?: string, @Query('fulfilment') fulfilment?: string) {
    return this.catalog.suggest(shop, (q ?? '').slice(0, 100), fulfilmentOf(fulfilment));
  }

  @Get('images/:id')
  async image(
    @CurrentShop() shop: ShopRequestContext,
    @Param('id') id: string,
    @Res() res: MediaResponse,
    @Query('size') size?: string,
  ) {
    const { body, contentType } = await this.catalog.image(
      shop,
      requireUuid(id, 'image'),
      size === 'thumb' ? 'thumb' : 'full',
    );
    res.header('Content-Type', contentType);
    // An image row's bytes never change; a replacement is a new id.
    res.header('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(body);
  }

  /** The banners showing in one place on the page. A brand header asks for its brand's. */
  @Get('banners')
  listBanners(
    @CurrentShop() shop: ShopRequestContext,
    @Query('placement') placement?: string,
    @Query('brand') brand?: string,
  ) {
    const parsed = bannerPlacementSchema.safeParse(placement);
    if (!parsed.success) {
      throw new ApiException('validation_failed', 'placement is home_hero, home_feature or brand_header', {
        retryable: false,
      });
    }
    return this.banners.forShop(shop, parsed.data, brand && uuidParam.safeParse(brand).success ? brand : undefined);
  }

  /**
   * A showing banner's picture or video. Video is served a range at a time,
   * which is how browsers ask for it and the only way Safari will play it.
   */
  @Get('banners/:id/media/:kind')
  async bannerMedia(
    @CurrentShop() shop: ShopRequestContext,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Res() res: MediaResponse,
    @Headers('range') range?: string,
  ) {
    if (!['image', 'mobile', 'video'].includes(kind)) throw ApiException.notFound('banner media');
    const media = await this.banners.shopMedia(shop, requireUuid(id, 'banner'), kind as BannerMediaKind, range);
    sendMedia(res, media);
  }
}

/** Write a picture or a ranged piece of video, with the headers a browser needs for each. */
export function sendMedia(
  res: MediaResponse,
  media: { body: Buffer; contentType: string; contentRange: string | null; totalBytes: number | null },
): void {
  res.header('Content-Type', media.contentType);
  res.header('Cache-Control', 'public, max-age=3600');
  if (media.contentType.startsWith('video/')) res.header('Accept-Ranges', 'bytes');
  if (media.contentRange) {
    res.status(206);
    res.header('Content-Range', media.contentRange);
  }
  res.send(media.body);
}

export const CART_TOKEN_HEADER = 'x-cart-token';

/** The shopper's cart. Guests and signed-in customers alike. */
@Controller({ path: 'shop/cart', version: '1' })
@ShopRoute()
export class ShopCartController {
  constructor(
    private readonly carts: CartsService,
    private readonly sessions: CustomerSessions,
  ) {}

  @Post()
  async create(@CurrentShop() shop: ShopRequestContext, @CustomerToken() sessionToken?: string) {
    return this.carts.create(shop, await this.sessions.resolve(shop, sessionToken));
  }

  @Get()
  async get(
    @CurrentShop() shop: ShopRequestContext,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.carts.get(shop, cartToken, await this.sessions.resolve(shop, sessionToken));
  }

  /** Pickup or delivery, and the ZIP code a delivery is going to. */
  @Put('fulfilment')
  async setFulfilment(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopSetFulfilmentSchema)) body: ReturnType<typeof shopSetFulfilmentSchema.parse>,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.carts.setFulfilment(shop, cartToken, await this.sessions.resolve(shop, sessionToken), body);
  }

  /** Set a line to an exact quantity. Zero takes it out. */
  @Put('lines/:variantId')
  async setLine(
    @CurrentShop() shop: ShopRequestContext,
    @Param('variantId') variantId: string,
    @Body(zodBody(shopSetCartLineSchema)) body: ReturnType<typeof shopSetCartLineSchema.parse>,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.carts.setLine(
      shop,
      cartToken,
      await this.sessions.resolve(shop, sessionToken),
      requireUuid(variantId, 'item'),
      body.quantity,
    );
  }

  /** Add to whatever quantity is already there: the product page's button. */
  @Post('lines/:variantId')
  @HttpCode(200)
  async addToLine(
    @CurrentShop() shop: ShopRequestContext,
    @Param('variantId') variantId: string,
    @Body(zodBody(shopSetCartLineSchema)) body: ReturnType<typeof shopSetCartLineSchema.parse>,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @CustomerToken() sessionToken?: string,
  ) {
    if (body.quantity < 1) {
      throw new ApiException('validation_failed', 'add at least one', { retryable: false });
    }
    return this.carts.addToLine(
      shop,
      cartToken,
      await this.sessions.resolve(shop, sessionToken),
      requireUuid(variantId, 'item'),
      body.quantity,
    );
  }
}

/** Placing an order, and following it afterwards. */
@Controller({ path: 'shop', version: '1' })
@ShopRoute()
export class ShopCheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly sessions: CustomerSessions,
  ) {}

  @Post('checkout')
  async place(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopCheckoutSchema)) body: ReturnType<typeof shopCheckoutSchema.parse>,
    @Headers(CART_TOKEN_HEADER) cartToken?: string,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.checkout.checkout(shop, cartToken, await this.sessions.resolve(shop, sessionToken), body);
  }

  @Get('orders/track/:token')
  track(@CurrentShop() shop: ShopRequestContext, @Param('token') token: string) {
    return this.checkout.track(shop, token);
  }

  @Post('orders/track/:token/cancel')
  @HttpCode(200)
  cancel(@CurrentShop() shop: ShopRequestContext, @Param('token') token: string) {
    return this.checkout.cancel(shop, token);
  }
}

/** Customer accounts: signing up, in and out, and everything behind the account page. */
@Controller({ path: 'shop/account', version: '1' })
@ShopRoute()
export class ShopAccountController {
  constructor(
    private readonly accounts: CustomerAccountsService,
    private readonly sessions: CustomerSessions,
  ) {}

  @Post('register')
  @HttpCode(202)
  register(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopRegisterSchema)) body: ReturnType<typeof shopRegisterSchema.parse>,
  ) {
    return this.accounts.register(shop, body);
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopTokenSchema)) body: ReturnType<typeof shopTokenSchema.parse>,
  ) {
    return this.accounts.verifyEmail(shop, body.token);
  }

  @Post('sign-in')
  @HttpCode(200)
  signIn(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopSignInSchema)) body: ReturnType<typeof shopSignInSchema.parse>,
  ) {
    return this.accounts.signIn(shop, body.email, body.password);
  }

  @Post('sign-out')
  @HttpCode(200)
  async signOut(@CurrentShop() shop: ShopRequestContext, @CustomerToken() sessionToken?: string) {
    await this.accounts.signOut(shop, sessionToken);
    return { ok: true };
  }

  @Post('forgot-password')
  @HttpCode(202)
  forgotPassword(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopForgotPasswordSchema)) body: ReturnType<typeof shopForgotPasswordSchema.parse>,
  ) {
    return this.accounts.forgotPassword(shop, body.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopResetPasswordSchema)) body: ReturnType<typeof shopResetPasswordSchema.parse>,
  ) {
    return this.accounts.resetPassword(shop, body.token, body.password);
  }

  @Get('me')
  async me(@CurrentShop() shop: ShopRequestContext, @CustomerToken() sessionToken?: string) {
    return this.accounts.profile(shop, await this.sessions.require(shop, sessionToken));
  }

  @Patch('me')
  async updateMe(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopUpdateProfileSchema)) body: ReturnType<typeof shopUpdateProfileSchema.parse>,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.accounts.updateProfile(shop, await this.sessions.require(shop, sessionToken), body);
  }

  @Post('me/password')
  @HttpCode(200)
  async changePassword(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopChangePasswordSchema)) body: ReturnType<typeof shopChangePasswordSchema.parse>,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.accounts.changePassword(
      shop,
      await this.sessions.require(shop, sessionToken),
      body.current_password,
      body.new_password,
    );
  }

  @Put('me/consents')
  async setConsents(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopConsentsSchema)) body: ReturnType<typeof shopConsentsSchema.parse>,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.accounts.setConsents(shop, await this.sessions.require(shop, sessionToken), body.marketing_email);
  }

  @Get('me/orders')
  async orders(@CurrentShop() shop: ShopRequestContext, @CustomerToken() sessionToken?: string) {
    return this.accounts.orders(shop, await this.sessions.require(shop, sessionToken));
  }

  /** Points, and where they came from, whether earned at the counter or online. */
  @Get('me/rewards')
  async rewards(@CurrentShop() shop: ShopRequestContext, @CustomerToken() sessionToken?: string) {
    return this.accounts.rewards(shop, await this.sessions.require(shop, sessionToken));
  }

  /** Text a code to prove a phone number. */
  @Post('me/phone')
  @HttpCode(202)
  async requestPhoneCode(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopRequestPhoneCodeSchema)) body: ReturnType<typeof shopRequestPhoneCodeSchema.parse>,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.accounts.requestPhoneCode(shop, await this.sessions.require(shop, sessionToken), body.phone);
  }

  /** The texted code. On success the phone is the account's, linked to in-store rewards if it was a member's. */
  @Post('me/phone/verify')
  @HttpCode(200)
  async confirmPhoneCode(
    @CurrentShop() shop: ShopRequestContext,
    @Body(zodBody(shopConfirmPhoneCodeSchema)) body: ReturnType<typeof shopConfirmPhoneCodeSchema.parse>,
    @CustomerToken() sessionToken?: string,
  ) {
    return this.accounts.confirmPhoneCode(shop, await this.sessions.require(shop, sessionToken), body.code);
  }
}
