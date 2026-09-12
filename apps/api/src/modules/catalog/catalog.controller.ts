import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createProductSchema,
  productSearchSchema,
  scanSchema,
  createCategorySchema,
  updateProductSchema,
  updateVariantSchema,
  setVariantPriceSchema,
} from '@snappos/contracts';
import { CatalogService } from './catalog.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** The scan path. Read only, so a cashier needs nothing beyond ringing a sale. */
  @Get('scan/:barcode')
  @RequirePermissions('sale.create')
  scan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('barcode') barcode: string,
    @Query('store_id') storeId: string,
  ) {
    const input = scanSchema.parse({ barcode, store_id: storeId });
    return this.catalog.scan(user.orgId, input.barcode, input.store_id);
  }

  @Get('products')
  @RequirePermissions('product.view')
  search(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string>) {
    return this.catalog.search(user.orgId, productSearchSchema.parse(query));
  }

  @Post('products')
  @RequirePermissions('product.create')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createProductSchema)) body: ReturnType<typeof createProductSchema.parse>,
    @Query('store_id') storeId?: string,
  ) {
    return this.catalog.createProduct(user.orgId, user.userId, body, storeId ?? user.storeId);
  }

  @Get('categories')
  @RequirePermissions('product.view')
  categories(@CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listCategories(user.orgId);
  }

  @Post('categories')
  @RequirePermissions('product.create')
  createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createCategorySchema)) body: ReturnType<typeof createCategorySchema.parse>,
  ) {
    return this.catalog.createCategory(user.orgId, body);
  }

  @Get('brands')
  @RequirePermissions('product.view')
  brands(@CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listBrands(user.orgId);
  }

  @Get('tax-categories')
  @RequirePermissions('product.view')
  taxCategories(@CurrentUser() user: AuthenticatedUser) {
    return this.catalog.listTaxCategories(user.orgId);
  }

  @Get('products/:id')
  @RequirePermissions('product.view')
  getProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('store_id') storeId?: string,
  ) {
    return this.catalog.getProduct(user.orgId, id, storeId ?? null);
  }

  @Patch('products/:id')
  @RequirePermissions('product.update')
  updateProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateProductSchema)) body: ReturnType<typeof updateProductSchema.parse>,
  ) {
    return this.catalog.updateProduct(user.orgId, user.userId, id, body);
  }

  @Patch('variants/:id')
  @RequirePermissions('product.update')
  updateVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateVariantSchema)) body: ReturnType<typeof updateVariantSchema.parse>,
  ) {
    return this.catalog.updateVariant(user.orgId, user.userId, id, body);
  }

  @Post('variants/:id/price')
  @RequirePermissions('product.update')
  setVariantPrice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(setVariantPriceSchema)) body: ReturnType<typeof setVariantPriceSchema.parse>,
  ) {
    return this.catalog.setVariantPrice(user.orgId, user.userId, id, body);
  }
}
