import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { loginSchema, refreshSchema } from '@snappos/contracts';
import { AuthService } from './auth.service.js';
import { Public } from './auth.guard.js';
import { zodBody } from '../validation/zod.pipe.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './auth.service.js';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(
    @Body(zodBody(loginSchema)) body: ReturnType<typeof loginSchema.parse>,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.login(body.email, body.password, {
      deviceId: body.device_id,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
  }

  @Public()
  @Post('refresh')
  refresh(
    @Body(zodBody(refreshSchema)) body: ReturnType<typeof refreshSchema.parse>,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.refresh(body.refresh_token, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
  }

  @Post('logout')
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(refreshSchema)) body: ReturnType<typeof refreshSchema.parse>,
  ) {
    await this.auth.logout(user.orgId, body.refresh_token);
    return { ok: true };
  }

  /** Who am I, and what may I do. The register calls this after an unlock. */
  @Post('session')
  session(@CurrentUser() user: AuthenticatedUser) {
    return {
      user_id: user.userId,
      org_id: user.orgId,
      store_id: user.storeId,
      register_id: user.registerId,
      permissions: user.permissions,
    };
  }
}
