import { Module } from '@nestjs/common';
import { MessagingModule } from '../../platform/messaging/messaging.module.js';
import { ObjectStorageModule } from '../../platform/storage/object-storage.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { BannersController } from './banners.controller.js';
import { BannersService } from './banners.service.js';
import { CartsService } from './carts.service.js';
import { CheckoutService } from './checkout.service.js';
import { CustomerAccountsService } from './customer-accounts.service.js';
import { CustomerSessions } from './customer-sessions.service.js';
import { ShopCatalogService } from './shop-catalog.service.js';
import {
  ShopAccountController,
  ShopCartController,
  ShopCatalogController,
  ShopCheckoutController,
} from './shop.controllers.js';
import { ShopNotifications } from './shop-notifications.service.js';
import { TrackingTokens } from './tracking-tokens.js';

/**
 * The public shop: everything the storefront website calls, and the banners
 * the back office puts on it.
 *
 * Built on the same services the back office and the register use -- the
 * orders, the compliance engine, the catalog and its photos, the loyalty
 * ledger and delivery -- so the website sells from the one inventory and the
 * one set of rules rather than a copy.
 */
@Module({
  imports: [OrdersModule, ComplianceModule, CatalogModule, MessagingModule, DeliveryModule, LoyaltyModule, ObjectStorageModule],
  controllers: [
    ShopCatalogController,
    ShopCartController,
    ShopCheckoutController,
    ShopAccountController,
    BannersController,
  ],
  providers: [
    ShopCatalogService,
    CartsService,
    CheckoutService,
    CustomerAccountsService,
    CustomerSessions,
    ShopNotifications,
    BannersService,
    { provide: TrackingTokens, useFactory: () => new TrackingTokens() },
  ],
})
export class ShopModule {}
