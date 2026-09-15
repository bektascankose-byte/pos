import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createProductSchema,
  createVariantSchema,
  productSearchSchema,
  scanSchema,
  createCategorySchema,
  createBrandSchema,
  updateProductSchema,
  bulkUpdateProductsSchema,
  updateVariantSchema,
  setVariantPriceSchema,
  bulkPriceVariantsSchema,
  suggestComplianceSchema,
  suggestVariantsSchema,
  createBarcodeSchema,
  createPriceCategorySchema,
  addPriceCategoryMembersSchema,
  scanPriceCategoryMemberSchema,
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

  /** The back office's own code lookup -- see `CatalogService.resolveCode` for why this isn't `scan`. */
  @Get('resolve/:code')
  @RequirePermissions('product.view')
  resolveCode(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.catalog.resolveCode(user.orgId, code);
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

  @Post('brands')
  @RequirePermissions('product.create')
  createBrand(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createBrandSchema)) body: ReturnType<typeof createBrandSchema.parse>,
  ) {
    return this.catalog.createBrand(user.orgId, body);
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

  @Post('products/:id/variants')
  @RequirePermissions('product.create')
  addVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(createVariantSchema)) body: ReturnType<typeof createVariantSchema.parse>,
  ) {
    return this.catalog.addVariant(user.orgId, user.userId, id, body);
  }

  /** Declared ahead of `products/:id` so Nest doesn't match "bulk" as an id. */
  @Patch('products/bulk')
  @RequirePermissions('product.bulk_update')
  bulkUpdateProducts(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(bulkUpdateProductsSchema)) body: ReturnType<typeof bulkUpdateProductsSchema.parse>,
  ) {
    return this.catalog.bulkUpdateProducts(user.orgId, user.userId, body);
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

  @Post('variants/bulk-price')
  @RequirePermissions('product.update')
  bulkSetPrice(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(bulkPriceVariantsSchema)) body: ReturnType<typeof bulkPriceVariantsSchema.parse>,
  ) {
    return this.catalog.bulkSetPrice(user.orgId, user.userId, body);
  }

  /** A suggestion only -- see `AiService.classifyCompliance`. Nothing here persists anything. */
  @Post('compliance/suggest')
  @RequirePermissions('product.create')
  suggestCompliance(
    @Body(zodBody(suggestComplianceSchema)) body: ReturnType<typeof suggestComplianceSchema.parse>,
  ) {
    return this.catalog.suggestCompliance(body);
  }

  /**
   * An alternate or carton code for an item that already exists. A carton code
   * carries `units` above 1 -- see `CatalogService.addBarcodeToVariant`.
   */
  @Post('variants/:variantId/barcodes')
  @RequirePermissions('product.update')
  addVariantBarcode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
    @Body(zodBody(createBarcodeSchema)) body: ReturnType<typeof createBarcodeSchema.parse>,
  ) {
    return this.catalog.addBarcodeToVariant(user.orgId, user.userId, variantId, body);
  }

  @Post('variants/barcodes/:barcodeId/remove')
  @RequirePermissions('product.update')
  removeVariantBarcode(@CurrentUser() user: AuthenticatedUser, @Param('barcodeId') barcodeId: string) {
    return this.catalog.removeBarcodeFromVariant(user.orgId, user.userId, barcodeId);
  }

  /** A suggestion only -- see `AiService.suggestProductVariants`. Nothing here persists anything. */
  @Post('variants/suggest')
  @RequirePermissions('product.create')
  suggestVariants(@Body(zodBody(suggestVariantsSchema)) body: ReturnType<typeof suggestVariantsSchema.parse>) {
    return this.catalog.suggestVariants(body);
  }

  @Get('price-categories')
  @RequirePermissions('product.view')
  listPriceCategories(@CurrentUser() user: AuthenticatedUser, @Query('store_id') storeId?: string) {
    return this.catalog.listPriceCategories(user.orgId, storeId ?? null);
  }

  @Post('price-categories')
  @RequirePermissions('product.update')
  createPriceCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createPriceCategorySchema)) body: ReturnType<typeof createPriceCategorySchema.parse>,
  ) {
    return this.catalog.createPriceCategory(user.orgId, user.userId, body.name);
  }

  @Get('price-categories/:id')
  @RequirePermissions('product.view')
  getPriceCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('store_id') storeId?: string,
  ) {
    return this.catalog.getPriceCategory(user.orgId, id, storeId ?? null);
  }

  @Post('price-categories/:id/members')
  @RequirePermissions('product.update')
  addPriceCategoryMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(addPriceCategoryMembersSchema)) body: ReturnType<typeof addPriceCategoryMembersSchema.parse>,
  ) {
    return this.catalog.addVariantsToPriceCategory(user.orgId, user.userId, id, body.variant_ids);
  }

  @Post('price-categories/:id/members/:variantId/remove')
  @RequirePermissions('product.update')
  removePriceCategoryMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('variantId') variantId: string,
  ) {
    return this.catalog.removeVariantFromPriceCategory(user.orgId, user.userId, variantId);
  }

  @Post('price-categories/:id/scan')
  @RequirePermissions('product.update')
  scanPriceCategoryMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(scanPriceCategoryMemberSchema)) body: ReturnType<typeof scanPriceCategoryMemberSchema.parse>,
  ) {
    return this.catalog.scanAddToPriceCategory(user.orgId, user.userId, id, body.code);
  }
}
