"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ShopCustomerProfile, ShopSession } from "@snappos/contracts";
import { ShopApiError, shopFetch } from "@/lib/api";
import { CART_COOKIE, cookieOptions, SESSION_COOKIE } from "@/lib/cookies";

export interface FormState {
  error: string | null;
  done: boolean;
  fields: Record<string, string>;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Only ever a path on this site. Anything else is how an open redirect starts. */
function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/account";
  return value;
}

async function startSession(session: ShopSession): Promise<void> {
  const expires = new Date(session.expires_at);
  (await cookies()).set(SESSION_COOKIE, session.session_token, { ...cookieOptions, expires });
  revalidatePath("/", "layout");
}

function message(e: unknown, fallback: string): string {
  return e instanceof ShopApiError ? e.message : fallback;
}

export async function signInAction(_previous: FormState, form: FormData): Promise<FormState> {
  const fields = { email: field(form, "email") };
  let session: ShopSession;
  try {
    session = await shopFetch<ShopSession>("/account/sign-in", {
      method: "POST",
      withSession: false,
      body: JSON.stringify({ email: fields.email, password: String(form.get("password") ?? "") }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't sign you in. Try again."), done: false, fields };
  }
  await startSession(session);
  redirect(safeNext(field(form, "next")));
}

export async function registerAction(_previous: FormState, form: FormData): Promise<FormState> {
  const fields = {
    first_name: field(form, "first_name"),
    last_name: field(form, "last_name"),
    email: field(form, "email"),
    marketing_email: form.get("marketing_email") === "yes" ? "yes" : "",
  };
  if (form.get("age_attested") !== "yes") {
    return { error: "You must be 21 or older to create an account.", done: false, fields };
  }
  try {
    await shopFetch("/account/register", {
      method: "POST",
      withSession: false,
      withCart: false,
      body: JSON.stringify({
        first_name: fields.first_name,
        last_name: fields.last_name,
        email: fields.email,
        password: String(form.get("password") ?? ""),
        marketing_email: fields.marketing_email === "yes",
        age_attested: true,
      }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't create the account. Try again."), done: false, fields };
  }
  return { error: null, done: true, fields };
}

/**
 * Confirming an email address is a button press, not the link itself.
 *
 * Email security scanners open every link in a message to check it. If opening
 * the link spent the token, those scanners would confirm addresses nobody had
 * read -- and use up the customer's own link before they clicked it.
 */
export async function verifyEmailAction(token: string, _previous: FormState): Promise<FormState> {
  let session: ShopSession;
  try {
    session = await shopFetch<ShopSession>("/account/verify-email", {
      method: "POST",
      withSession: false,
      withCart: false,
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    return { error: message(e, "That link didn't work. Ask for a new one."), done: false, fields: {} };
  }
  await startSession(session);
  redirect("/account?welcome=1");
}

export async function forgotPasswordAction(_previous: FormState, form: FormData): Promise<FormState> {
  const fields = { email: field(form, "email") };
  try {
    await shopFetch("/account/forgot-password", {
      method: "POST",
      withSession: false,
      withCart: false,
      body: JSON.stringify(fields),
    });
  } catch (e) {
    return { error: message(e, "Couldn't send the email. Try again."), done: false, fields };
  }
  return { error: null, done: true, fields };
}

export async function resetPasswordAction(token: string, _previous: FormState, form: FormData): Promise<FormState> {
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) {
    return { error: "The two passwords don't match.", done: false, fields: {} };
  }
  let session: ShopSession;
  try {
    session = await shopFetch<ShopSession>("/account/reset-password", {
      method: "POST",
      withSession: false,
      withCart: false,
      body: JSON.stringify({ token, password }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't reset the password. Ask for a new link."), done: false, fields: {} };
  }
  await startSession(session);
  redirect("/account?reset=1");
}

export async function signOutAction(): Promise<void> {
  try {
    await shopFetch("/account/sign-out", { method: "POST", withCart: false });
  } catch {
    // Signed out here either way: the cookie goes below.
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  // A cart that belonged to the account stays with the account, not with
  // whoever uses this browser next.
  jar.delete(CART_COOKIE);
  revalidatePath("/", "layout");
  redirect("/");
}

export async function updateProfileAction(_previous: FormState, form: FormData): Promise<FormState> {
  const fields = {
    first_name: field(form, "first_name"),
    last_name: field(form, "last_name"),
    phone: field(form, "phone"),
  };
  try {
    await shopFetch<ShopCustomerProfile>("/account/me", {
      method: "PATCH",
      withCart: false,
      body: JSON.stringify({ ...fields, phone: fields.phone || null }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't save your details."), done: false, fields };
  }
  revalidatePath("/account");
  return { error: null, done: true, fields };
}

export async function changePasswordAction(_previous: FormState, form: FormData): Promise<FormState> {
  const next = String(form.get("new_password") ?? "");
  if (next !== String(form.get("confirm") ?? "")) {
    return { error: "The two new passwords don't match.", done: false, fields: {} };
  }
  try {
    await shopFetch("/account/me/password", {
      method: "POST",
      withCart: false,
      body: JSON.stringify({ current_password: String(form.get("current_password") ?? ""), new_password: next }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't change your password."), done: false, fields: {} };
  }
  return { error: null, done: true, fields: {} };
}

export async function setMarketingAction(_previous: FormState, form: FormData): Promise<FormState> {
  const marketing = form.get("marketing_email") === "yes";
  try {
    await shopFetch<ShopCustomerProfile>("/account/me/consents", {
      method: "PUT",
      withCart: false,
      body: JSON.stringify({ marketing_email: marketing }),
    });
  } catch (e) {
    return { error: message(e, "Couldn't save your choice."), done: false, fields: {} };
  }
  revalidatePath("/account");
  return { error: null, done: true, fields: { marketing_email: marketing ? "yes" : "" } };
}
