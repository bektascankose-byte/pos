import "server-only";
import { getAccessToken } from "./session";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public userMessage: string | undefined,
  ) {
    super(userMessage ?? `API request failed (HTTP ${status})`);
  }
}

/**
 * Server-only. By the time any Server Component or Server Action calls this,
 * `middleware.ts` has already ensured the access token is fresh -- this
 * function does not retry or refresh, it just attaches whatever token the
 * request currently has.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    // Every call here is either a live report or an admin action -- neither
    // should ever be served from a cache.
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.code, body?.user_message ?? body?.message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
