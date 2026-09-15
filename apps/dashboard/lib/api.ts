import "server-only";
import { getAccessToken } from "./session";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

interface ValidationIssue {
  path?: string;
  message?: string;
}

/**
 * A rejected field says which field and why.
 *
 * The API answers a failed `zodBody` with a generic `"the request did not
 * validate"` plus an `issues` array naming each field. Dropping that array
 * left every validation failure in the whole back office reading as that one
 * unhelpful sentence -- a phone in the wrong format and a missing name were
 * indistinguishable. The issues are folded into the message instead.
 */
function describe(body: { message?: string; user_message?: string; issues?: ValidationIssue[] } | null): string | undefined {
  const issues = body?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const detail = issues
      .slice(0, 3)
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .filter(Boolean)
      .join("; ");
    if (detail) return detail;
  }
  return body?.user_message ?? body?.message;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public userMessage: string | undefined,
    public issues: ValidationIssue[] = [],
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
      // Only when there's actually a body -- Fastify refuses a
      // Content-Type: application/json request with no body at all, which
      // every no-body DELETE (like removing a role assignment) otherwise is.
      // A FormData body (a file upload) gets no explicit Content-Type either:
      // fetch sets its own multipart boundary, and overriding it here would
      // send the boundary-less header value instead, breaking every upload.
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    // Every call here is either a live report or an admin action -- neither
    // should ever be served from a cache.
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.code, describe(body), body?.issues ?? []);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
