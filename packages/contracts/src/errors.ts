/**
 * Error contract.
 *
 * One shape for every failure, because four applications consume this API and
 * each one inventing its own error handling is how a cashier ends up staring at
 * "[object Object]" during a queue.
 *
 * `code` is stable and machine readable. `message` is for a developer.
 * `user_message`, when present, has been written for a cashier to act on.
 */

import { z } from 'zod';

export const errorCode = z.enum([
  'validation_failed',
  'unauthenticated',
  'invalid_credentials',
  'token_expired',
  'forbidden',
  'manager_approval_required',
  'not_found',
  'conflict',
  'idempotency_key_reuse',
  'insufficient_stock',
  'compliance_blocked',
  'age_verification_required',
  'rate_limited',
  'provider_unavailable',
  'internal_error',
]);

export const apiErrorSchema = z.object({
  code: errorCode,
  message: z.string(),
  user_message: z.string().optional(),
  /** Field level detail for validation_failed. */
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
  /** Correlates a user's screenshot with a log line. */
  request_id: z.string(),
  /**
   * Whether retrying the identical request could succeed. The register's sync
   * queue reads this to decide between backing off and dead lettering, so it
   * has to be accurate rather than optimistic.
   */
  retryable: z.boolean().default(false),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ErrorCode = z.infer<typeof errorCode>;
