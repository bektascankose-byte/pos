"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_COOKIE, cookieOptions } from "@/lib/cookies";
import { getRefreshToken } from "@/lib/session";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";

export async function loginAction(_prevState: string | null, formData: FormData): Promise<string> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return body?.user_message ?? body?.message ?? "Sign in failed";
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    session: unknown;
  };

  const store = await cookies();
  store.set(ACCESS_COOKIE, body.access_token, cookieOptions);
  store.set(REFRESH_COOKIE, body.refresh_token, cookieOptions);
  store.set(SESSION_COOKIE, JSON.stringify(body.session), cookieOptions);

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const refreshToken = await getRefreshToken();
  const accessToken = (await cookies()).get(ACCESS_COOKIE)?.value;

  if (refreshToken && accessToken) {
    // Best effort -- a failed revoke server side should never trap someone
    // signed in on this device. The cookies are cleared regardless.
    await fetch(`${API_BASE_URL}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => undefined);
  }

  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(SESSION_COOKIE);

  redirect("/login");
}
