import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE, cookieOptions } from "./lib/cookies";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

/**
 * Decoded without verifying the signature -- that's the API's job on every
 * request that matters. This is only used to decide whether it's worth
 * trying the request with the token we have, or refreshing first.
 */
function isExpired(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    // A 30 second margin so a request in flight doesn't race the real expiry.
    return typeof json.exp !== "number" || json.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true;
  }
}

/**
 * Runs before every page in this app (see `matcher` below) and is the only
 * place other than a Server Action that Next.js allows a cookie to actually
 * be written -- a Server Component reading the same cookie mid-render cannot
 * refresh it. So the refresh-when-close-to-expiry logic lives here, not in
 * `lib/api.ts`: by the time a page renders, its access token is already good
 * for the life of that request.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isLogin = pathname === "/login";

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  if (access && !isExpired(access)) {
    return isLogin ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  if (!refresh) {
    return isLogin ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const apiResponse = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!apiResponse.ok) throw new Error(`refresh failed: HTTP ${apiResponse.status}`);
    const body = (await apiResponse.json()) as {
      access_token: string;
      refresh_token: string;
      session: unknown;
    };

    const response = isLogin
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
    response.cookies.set(ACCESS_COOKIE, body.access_token, cookieOptions);
    response.cookies.set(REFRESH_COOKIE, body.refresh_token, cookieOptions);
    response.cookies.set(SESSION_COOKIE, JSON.stringify(body.session), cookieOptions);
    return response;
  } catch {
    // The refresh token is dead (expired, revoked, or already used -- see
    // `AuthService.refresh`'s reuse detection). Nothing recovers this session;
    // clear it and start over rather than looping on a refresh that will
    // never succeed.
    if (isLogin) return NextResponse.next();
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete(ACCESS_COOKIE);
    response.cookies.delete(REFRESH_COOKIE);
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
