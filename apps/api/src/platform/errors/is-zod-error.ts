/**
 * Recognise a ZodError without `instanceof`.
 *
 * The API compiles to CommonJS and @snappos/contracts is ESM, so each half
 * loads a different copy of zod even though npm installs exactly one version.
 * `instanceof` compares constructor identity and is therefore false across that
 * boundary, which turned every validation failure into a 500. Checking the
 * shape works regardless of how many copies are loaded.
 */
export interface ZodLikeIssue {
  path: (string | number)[];
  message: string;
}

export interface ZodLikeError {
  name: string;
  issues: ZodLikeIssue[];
}

export function isZodError(error: unknown): error is ZodLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}
