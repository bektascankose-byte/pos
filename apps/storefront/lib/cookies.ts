/**
 * Cookie names and options. Dependency-free so `middleware.ts`, which runs on
 * the Edge runtime, can import it.
 *
 * Every cookie here is httpOnly: the cart token and the session token are
 * bearer credentials, and there is no reason for any script in the page to be
 * able to read them.
 */

export const CART_COOKIE = "shop_cart";
export const SESSION_COOKIE = "shop_session";
/** Set once a visitor says they are 21 or older. A courtesy gate, never a verification. */
export const AGE_COOKIE = "shop_age_ok";

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "lax" as const,
  path: "/",
};

export const THIRTY_DAYS = 60 * 60 * 24 * 30;
