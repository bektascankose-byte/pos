import { PipeTransform, Injectable, type ArgumentMetadata } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';
import { ApiException } from '../errors/api-exception.js';
import { isZodError } from '../errors/is-zod-error.js';

/**
 * Validate with a Zod schema from the contracts package.
 *
 * Deliberately not class-validator. The schemas are already the source of truth
 * for the OpenAPI document and the register's generated Kotlin client, and a
 * second set of DTO decorators would be a parallel definition that drifts from
 * the first one the week someone is in a hurry.
 *
 * The parsed value replaces the raw one, so handlers receive coerced, defaulted,
 * branded types rather than whatever JSON arrived.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // Converted here rather than thrown onward, so validation failure is the
    // API's own error type from the moment it happens. Relying on the filter to
    // recognise a foreign ZodError is fragile: this app compiles to CommonJS
    // and the contracts package is ESM, so the two halves load different copies
    // of zod and `instanceof` is false across that boundary.
    throw new ApiException('validation_failed', 'the request did not validate', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
      retryable: false,
    });
  }
}

/** `@Body(zodBody(createProductSchema))` reads better at the call site. */
export const zodBody = (schema: ZodTypeAny) => new ZodValidationPipe(schema);
