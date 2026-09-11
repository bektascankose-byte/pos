import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TokenService } from './token.service.js';
import { ApiException } from '../errors/api-exception.js';
import type { AuthenticatedUser } from './auth.service.js';

export const PUBLIC_KEY = 'snappos:public';
export const PERMISSIONS_KEY = 'snappos:permissions';

/** Opt a route out of authentication. Used by login, refresh and health only. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Require permissions. Every one listed must be held, not any of them: a route
 * that touches both cost and customer data needs both, and "any" would be the
 * kind of default that quietly widens access as routes grow.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authentication and authorization in one pass.
 *
 * Registered globally, so a new controller is protected by default and opting
 * out is an explicit, greppable decorator. The reverse default - protection
 * added per route - eventually ships an unguarded endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new ApiException('unauthenticated', 'missing bearer token');
    }

    const claims = await this.tokens.verifyAccessToken(header.slice(7));

    request.user = {
      userId: claims.sub,
      orgId: claims.org,
      storeId: claims.store,
      registerId: claims.register,
      displayName: '',
      permissions: claims.perms ?? [],
    };

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const held = new Set(request.user.permissions);
    const missing = required.filter((p) => !held.has(p));

    if (missing.length > 0) throw ApiException.forbidden(missing.join(', '));

    return true;
  }
}
