/**
 * Cookie names and options, kept dependency-free (no `next/headers`) so this
 * file can be imported from `middleware.ts`, which runs on the Edge runtime
 * and cannot use the Node-oriented `next/headers` cookie API. Anything that
 * needs to *read* a cookie from a Server Component or Server Action lives in
 * `lib/session.ts` instead.
 */

export const ACCESS_COOKIE = "sp_access";
export const REFRESH_COOKIE = "sp_refresh";
/**
 * The login/refresh response's `session` object (user id, org id, display
 * name, permissions), stored verbatim as JSON. The access token itself
 * carries no display name -- see `TokenService.SnapposClaims` -- and this is
 * cheaper and more honest than decoding the JWT and hoping its shape never
 * changes underneath this app.
 */
export const SESSION_COOKIE = "sp_session";

/**
 * httpOnly so the tokens never reach client-side JavaScript at all -- the
 * whole point of the backend-for-frontend pattern this app uses. `secure`
 * is env-driven because local dev runs over plain http, where a browser
 * silently drops a Secure cookie instead of storing it.
 */
export const cookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "lax" as const,
  path: "/",
};
