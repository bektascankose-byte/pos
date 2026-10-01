"use server";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

/**
 * Ask for a reset link.
 *
 * Not `apiFetch`, deliberately: that one attaches the signed in user's token,
 * and nobody here is signed in. This is one of the two routes the API marks
 * public.
 *
 * Always returns the same thing. The API already refuses to say whether an
 * address has an account, and a dashboard that leaked it through a different
 * error message would undo that. Even a network failure reads as sent, with
 * the real reason going to the server log where somebody can act on it.
 */
export async function requestPasswordResetAction(
  _previous: string | null,
  formData: FormData,
): Promise<string | null> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return "Enter the email address you sign in with.";

  try {
    await fetch(`${API_BASE_URL}/api/v1/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      cache: "no-store",
    });
  } catch (error) {
    console.error("password reset request could not reach the API", error);
  }
  return null;
}
