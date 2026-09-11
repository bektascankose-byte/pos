import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException } from './api-exception.js';
import { isZodError } from './is-zod-error.js';
import { mapPostgresError } from './postgres-error.js';
import type { ApiError } from '@snappos/contracts';

/**
 * Turns every failure into the one error shape the contracts package defines.
 *
 * Two things this filter is careful about:
 *
 * Nothing internal reaches the client. A Postgres error message can contain a
 * constraint name, a column list, or the value that violated it, and on this
 * schema that value may be a customer's phone number. Unexpected errors become
 * a generic 500 with a request id; the detail goes to the log.
 *
 * `retryable` is set honestly. The register's sync queue trusts it.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = request.id as string;

    const { status, body } = this.render(exception, requestId);

    const pgCode = (exception as { code?: string }).code;
    if (status >= 500 || (typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode))) {
      this.logger.error(
        {
          requestId,
          method: request.method,
          url: request.url,
          err: exception instanceof Error ? exception.stack : String(exception),
        },
        'unhandled error',
      );
    }

    void reply.status(status).send(body);
  }

  private render(exception: unknown, requestId: string): { status: number; body: ApiError } {
    if (exception instanceof ApiException) {
      const response = exception.getResponse() as {
        code: ApiError['code'];
        message: string;
        userMessage?: string;
        issues?: { path: string; message: string }[];
      };
      return {
        status: exception.getStatus(),
        body: {
          code: response.code,
          message: response.message,
          ...(response.userMessage ? { user_message: response.userMessage } : {}),
          ...(response.issues ? { issues: response.issues } : {}),
          request_id: requestId,
          retryable: exception.retryable,
        },
      };
    }

    if (isZodError(exception)) {
      return {
        status: 400,
        body: {
          code: 'validation_failed',
          message: 'the request body did not validate',
          issues: exception.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          request_id: requestId,
          // A malformed request will be malformed the second time too.
          retryable: false,
        },
      };
    }

    // A constraint violation is a statement about the request, not a server
    // fault. Mapped to a clean 4xx with a stable code; the database's own
    // message stays in the log, because it can quote the offending value.
    const fromPostgres = mapPostgresError(exception);
    if (fromPostgres) {
      const response = fromPostgres.getResponse() as { code: ApiError['code']; message: string; userMessage?: string };
      return {
        status: fromPostgres.getStatus(),
        body: {
          code: response.code,
          message: response.message,
          ...(response.userMessage ? { user_message: response.userMessage } : {}),
          request_id: requestId,
          retryable: fromPostgres.retryable,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          code: status === 404 ? 'not_found' : status >= 500 ? 'internal_error' : 'validation_failed',
          message: exception.message,
          request_id: requestId,
          retryable: status >= 500,
        },
      };
    }

    // Anything unrecognized. The message is deliberately useless to the client
    // and complete in the log.
    return {
      status: 500,
      body: {
        code: 'internal_error',
        message: 'an unexpected error occurred',
        user_message: 'Something went wrong. The sale is safe; try again.',
        request_id: requestId,
        retryable: true,
      },
    };
  }
}
