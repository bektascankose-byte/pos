import "server-only";
import { cookies } from "next/headers";
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from "./cookies";

/** Read-only cookie access for Server Components. Setting cookies is only
 * legal from a Server Action, a Route Handler, or Middleware -- see
 * `app/login/actions.ts` and `middleware.ts` for where that actually happens.
 */
export async function getAccessToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(REFRESH_COOKIE)?.value;
}

export interface Session {
  userId: string;
  orgId: string;
  displayName: string;
  permissions: string[];
}

/** Whoever is signed in, straight from what login/refresh returned -- see `SESSION_COOKIE`. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
