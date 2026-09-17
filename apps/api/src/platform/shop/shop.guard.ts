import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { Public } from '../auth/auth.guard.js';
import { ApiException } from '../errors/api-exception.js';
import { ShopKeyRegistry, type ShopClient } from './shop-key.registry.js';

/** The shop a request is for, and who is shopping. */
export interface ShopRequestContext extends ShopClient {
  /**
   * The shopper's own address, as the storefront server saw it. Used for rate
   * limiting and as consent evidence -- never logged.
   */
  shopperIp: string;
  userAgent: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    shop?: ShopRequestContext;
  }
}

export const SHOP_KEY_HEADER = 'x-shop-key';
export const SHOPPER_IP_HEADER = 'x-shopper-ip';
export const SHOPPER_AGENT_HEADER = 'x-shopper-agent';

/**
 * Authenticates the storefront server.
 *
 * Not the shopper: shoppers are anonymous until they sign in, and a signed-in
 * shopper is a customer session checked separately. What this establishes is
 * that the request came through the shop's own website, and which shop that is.
 *
 * The forwarded address and user agent are trusted only once the key checks
 * out. From anyone else they would be a way to dodge rate limits by claiming a
 * different address on every request.
 */
@Injectable()
export class ShopGuard implements CanActivate {
  constructor(private readonly keys: ShopKeyRegistry) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const key = request.headers[SHOP_KEY_HEADER];

    if (typeof key !== 'string' || key.length < 16 || key.length > 200) {
      throw new ApiException('unauthenticated', 'missing shop key');
    }

    const client = await this.keys.resolve(key);
    if (!client) throw new ApiException('unauthenticated', 'invalid shop key');

    const forwarded = request.headers[SHOPPER_IP_HEADER];
    const agent = request.headers[SHOPPER_AGENT_HEADER];
    request.shop = {
      ...client,
      shopperIp: typeof forwarded === 'string' && isIP(forwarded) !== 0 ? forwarded : request.ip,
      userAgent: typeof agent === 'string' ? agent.slice(0, 300) : undefined,
    };
    return true;
  }
}

/**
 * A route the storefront calls. Skips staff authentication, which a shopper
 * does not have, and requires the shop key instead.
 */
export const ShopRoute = () => applyDecorators(Public(), UseGuards(ShopGuard));

export const CurrentShop = createParamDecorator((_data: unknown, context: ExecutionContext): ShopRequestContext => {
  const shop = context.switchToHttp().getRequest<FastifyRequest>().shop;
  if (!shop) throw new ApiException('unauthenticated', 'missing shop key');
  return shop;
});

/** The rate limiter's key for a storefront request, if the key is already known. */
export function shopRateLimitKey(
  registry: ShopKeyRegistry,
  headers: Record<string, unknown>,
  ip: string,
): string | null {
  const key = headers[SHOP_KEY_HEADER];
  if (typeof key !== 'string') return null;
  const client = registry.peek(key);
  if (!client) return null;
  const forwarded = headers[SHOPPER_IP_HEADER];
  const shopper = typeof forwarded === 'string' && isIP(forwarded) !== 0 ? forwarded : ip;
  return `shop:${client.clientId}:${shopper}`;
}
