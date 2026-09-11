import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiException } from '../errors/api-exception.js';
import type { AuthenticatedUser } from './auth.service.js';

/**
 * The authenticated caller.
 *
 * Throws rather than returning undefined when absent. A handler that reads
 * `user.orgId` from an unauthenticated request would query with `undefined` as
 * the org, and the RLS policy would return an empty set rather than an error,
 * turning a missing guard into a puzzling empty list instead of a loud failure.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.user) {
      throw new ApiException('unauthenticated', 'route reached without an authenticated user');
    }
    return request.user;
  },
);
