"use server";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

/**
 * Set the new password.
 *
 * Unlike the request step this one does report failure, because by here the
 * person holds a token and the two things that can go wrong -- a dead link
 * and a password that is too short -- are both things they need told in order
 * to get in. Neither reveals anything about anyone else's account.
 */
/**
 * Success is its own value rather than "no error", because the token is spent
 * on the first try. A page that could not tell the two apart would have to
 * submit again to find out, and the second attempt would always fail.
 */
export type ResetOutcome = { ok: true } | { ok: false; error: string };

export async function completePasswordResetAction(
  _previous: ResetOutcome | null,
  formData: FormData,
): Promise<ResetOutcome> {
  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token) return { ok: false, error: "That link is missing its code. Ask for a new one." };
  if (password.length < 8) return { ok: false, error: "Use at least 8 characters." };
  if (password !== confirm) return { ok: false, error: "Those two passwords do not match." };

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/password-reset/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
      cache: "no-store",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { user_message?: string; message?: string }
        | null;
      return {
        ok: false,
        error: body?.user_message ?? body?.message ?? "That link did not work. Ask for a new one.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server. Try again in a moment." };
  }
}
