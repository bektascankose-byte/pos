import { NextResponse, type NextRequest } from "next/server";
import { AGE_COOKIE } from "./lib/cookies";

/**
 * The 21+ entrance gate.
 *
 * A courtesy, not a control, and nothing downstream treats it as one: checkout
 * asks the customer to state their age again and records that statement, and
 * the check that counts happens at the counter with the ID in hand. The gate
 * only keeps the shop from greeting a visitor who has said nothing at all with
 * a wall of vape products.
 *
 * Legal pages and the gate itself stay reachable without it, so a person can
 * read the age policy before deciding what to answer.
 */
export function middleware(request: NextRequest) {
  if (request.cookies.get(AGE_COOKIE)?.value === "yes") return NextResponse.next();

  const url = request.nextUrl.clone();
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = "/age-check";
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!age-check|legal|img|api|_next|favicon.ico|robots.txt).*)"],
};
