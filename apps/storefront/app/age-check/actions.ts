"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AGE_COOKIE, cookieOptions, THIRTY_DAYS } from "@/lib/cookies";

/** Remember the answer for a month, then carry on to where the visitor was going. */
export async function confirmAgeAction(form: FormData): Promise<void> {
  const next = String(form.get("next") ?? "/");
  (await cookies()).set(AGE_COOKIE, "yes", { ...cookieOptions, maxAge: THIRTY_DAYS });
  redirect(next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");
}
