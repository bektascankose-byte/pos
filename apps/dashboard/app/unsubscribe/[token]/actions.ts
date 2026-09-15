"use server";

import type { ActionResult } from "@/lib/action-result";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

/**
 * Unsubscribe, without a session.
 *
 * Deliberately does NOT go through `apiFetch`: that attaches the logged-in
 * user's access token, and there is no logged-in user here — the person is a
 * customer reading their email. The token in the URL is the whole
 * authorization, which is why the API route is `@Public()` and the token is 24
 * random bytes scoped to one recipient of one campaign.
 */
export async function unsubscribeAction(token: string): Promise<ActionResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/marketing/unsubscribe/${encodeURIComponent(token)}`, {
      method: "POST",
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, error: "That link is no longer valid." };
    return { ok: true, data: undefined };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}
