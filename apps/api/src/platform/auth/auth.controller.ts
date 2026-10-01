import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  completePasswordResetSchema,
} from '@snappos/contracts';
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

  /**
   * Ask for a reset link.
   *
   * Always 200 with the same body, whether or not that address has an
   * account: a different answer, or a different response time, is a way to
   * find out who banks here. Rate limiting is the global one, which matters
   * more on this route than most because it sends mail on demand.
   *
   * The link's base comes from the server's own configuration, never from the
   * request. A `reset_url_base` a caller could set would be an open redirect
   * that mails itself to the victim.
   */
  @Public()
  @Post('password-reset/request')
  @HttpCode(200)
  async requestPasswordReset(
    @Body(zodBody(requestPasswordResetSchema))
    body: ReturnType<typeof requestPasswordResetSchema.parse>,
    @Req() request: FastifyRequest,
  ) {
    await this.auth.requestPasswordReset(body.email, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      resetUrlBase: process.env.DASHBOARD_URL ?? 'http://localhost:3001',
    });
    return { ok: true as const };
  }

  /** Set the new password. Throws when the link is unknown, expired or already spent. */
  @Public()
  @Post('password-reset/complete')
  @HttpCode(200)
  async completePasswordReset(
    @Body(zodBody(completePasswordResetSchema))
    body: ReturnType<typeof completePasswordResetSchema.parse>,
  ) {
    await this.auth.completePasswordReset(body.token, body.password);
    return { ok: true as const };
  }

  @Post('logout')
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(refreshSchema)) body: ReturnType<typeof refreshSchema.parse>,
  ) {
    await this.auth.logout(user.orgId, body.refresh_token);
    return { ok: true };
  }

  /**
   * Who am I, and what may I do. The register calls this after an unlock.
   *
   * GET, because it reads and changes nothing. It was briefly a POST, which
   * Fastify rejects when a client sends a JSON content type with no body.
   */
  @Get('session')
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
