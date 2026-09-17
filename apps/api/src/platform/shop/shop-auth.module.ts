import { Global, Module } from '@nestjs/common';
import { ShopKeyRegistry } from './shop-key.registry.js';
import { ShopGuard } from './shop.guard.js';

/**
 * Storefront key resolution. Global because the rate limiter in `main.ts`
 * reads the same registry every shop route resolves through, and two caches
 * would disagree about which keys are known.
 */
@Global()
@Module({
  providers: [ShopKeyRegistry, ShopGuard],
  exports: [ShopKeyRegistry, ShopGuard],
})
export class ShopAuthModule {}
