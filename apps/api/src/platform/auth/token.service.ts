import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { ApiException } from '../errors/api-exception.js';

/** The claims this API puts in an access token, beyond the registered ones. */
export interface SnapposClaims {
  sub: string;
  org: string;
  store: string | null;
  register: string | null;
  perms: string[];
}

export type AccessClaims = JWTPayload & SnapposClaims;

/**
 * Access and refresh tokens.
 *
 * Access tokens are short lived and carry the permission set, so the hot path
 * does not hit the database to decide whether a cashier may discount a line.
 * The cost of that is staleness: a permission revoked mid shift takes effect
 * when the token expires. Fifteen minutes is the compromise, and anything
 * genuinely dangerous (refund, price override, drawer open) additionally
 * requires a manager PIN checked live against the database, so a revoked
 * manager cannot approve anything even with a valid token in hand.
 *
 * Refresh tokens rotate. Using one invalidates it and issues a new pair. A
 * replay of a spent token means it was copied, so the entire family is revoked
 * and the user is signed out everywhere. This is what makes theft of a refresh
 * token detectable rather than permanent.
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);
  private secret!: Uint8Array;

  private readonly accessTtlSeconds = Number(process.env.ACCESS_TOKEN_TTL ?? 900);
  readonly refreshTtlSeconds = Number(process.env.REFRESH_TOKEN_TTL ?? 60 * 60 * 24 * 30);

  onModuleInit(): void {
    const raw = process.env.JWT_SECRET;

    if (!raw || raw.length < 32) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set to at least 32 characters in production');
      }
      // A generated development secret invalidates every token on restart,
      // which is mildly annoying and far better than a default secret that
      // someone eventually ships.
      this.secret = randomBytes(32);
      this.logger.warn('JWT_SECRET not set; using a random development secret');
      return;
    }
    this.secret = new TextEncoder().encode(raw);
  }

  async issueAccessToken(claims: SnapposClaims): Promise<{
    token: string;
    expiresIn: number;
  }> {
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('snappos')
      .setAudience('snappos-api')
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.secret);

    return { token, expiresIn: this.accessTtlSeconds };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: 'snappos',
        audience: 'snappos-api',
      });
      return payload as AccessClaims;
    } catch (error) {
      const expired = (error as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new ApiException(
        expired ? 'token_expired' : 'unauthenticated',
        expired ? 'access token expired' : 'invalid access token',
        { retryable: false },
      );
    }
  }

  /**
   * A refresh token is opaque random bytes, not a JWT. Only its SHA-256 hash is
   * stored, so a leaked database dump does not hand over working sessions.
   * There is nothing to verify cryptographically: the database row is the
   * authority, which is exactly what makes revocation instant.
   */
  mintRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
