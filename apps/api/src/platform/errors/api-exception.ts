import { HttpException } from '@nestjs/common';
import type { ErrorCode } from '@snappos/contracts';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  token_expired: 401,
  forbidden: 403,
  manager_approval_required: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reuse: 409,
  insufficient_stock: 409,
  compliance_blocked: 422,
  age_verification_required: 422,
  rate_limited: 429,
  provider_unavailable: 503,
  internal_error: 500,
};

/**
 * Every failure this API raises deliberately.
 *
 * `retryable` is not decoration. The register's sync queue reads it to choose
 * between backing off and dead lettering, so an inaccurate value either drops a
 * sale or retries a doomed request forever. Default it from the status code and
 * override only where the specific case is known.
 */
export class ApiException extends HttpException {
  readonly code: ErrorCode;
  // Named `detail` rather than `options`: HttpException already has a private
  // `options` member, and shadowing it is a compile error in strict mode.
  readonly detail: {
    userMessage?: string | undefined;
    issues?: { path: string; message: string }[] | undefined;
    retryable?: boolean | undefined;
  };

  constructor(
    code: ErrorCode,
    message: string,
    detail: {
      userMessage?: string | undefined;
      issues?: { path: string; message: string }[] | undefined;
      retryable?: boolean | undefined;
    } = {},
  ) {
    super({ code, message, ...detail }, STATUS[code]);
    this.code = code;
    this.detail = detail;
  }

  get retryable(): boolean {
    return this.detail.retryable ?? STATUS[this.code] >= 500;
  }

  static notFound(what: string): ApiException {
    return new ApiException('not_found', `${what} not found`);
  }

  static forbidden(permission: string): ApiException {
    return new ApiException('forbidden', `missing permission: ${permission}`, {
      userMessage: 'You do not have permission to do that. Ask a manager.',
    });
  }
}
