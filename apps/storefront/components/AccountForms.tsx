"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ShopCustomerProfile } from "@snappos/contracts";
import {
  changePasswordAction,
  forgotPasswordAction,
  registerAction,
  resetPasswordAction,
  setMarketingAction,
  signInAction,
  updateProfileAction,
  verifyEmailAction,
  type FormState,
} from "@/app/account/actions";

const EMPTY: FormState = { error: null, done: false, fields: {} };

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

function Input({
  id,
  label,
  type = "text",
  autoComplete,
  required = true,
  defaultValue,
  hint,
  minLength,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  defaultValue?: string;
  hint?: string;
  minLength?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        defaultValue={defaultValue}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="field"
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-[var(--muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Problem({ state }: { state: FormState }) {
  return state.error ? (
    <p role="alert" className="rounded-xl border border-[var(--danger)] px-4 py-3 text-sm text-[var(--danger)]">
      {state.error}
    </p>
  ) : null;
}

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(signInAction, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Input id="email" label="Email" type="email" autoComplete="email" defaultValue={state.fields.email} />
      <Input id="password" label="Password" type="password" autoComplete="current-password" />
      <Problem state={state} />
      <Submit label="Sign in" busy="Signing in…" />
      <p className="text-sm">
        <Link href="/account/forgot-password" className="underline underline-offset-2">
          Forgotten your password?
        </Link>
      </p>
    </form>
  );
}

export function RegisterForm() {
  const [state, action] = useActionState(registerAction, EMPTY);
  if (state.done) {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <p className="font-semibold">Check your email.</p>
        <p className="text-sm text-[var(--muted)]">
          We&apos;ve sent a link to {state.fields.email || "your email address"}. Follow it to finish setting up your
          account. If you already have an account, we&apos;ve emailed you about that instead.
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id="first_name" label="First name" autoComplete="given-name" defaultValue={state.fields.first_name} />
        <Input id="last_name" label="Last name" autoComplete="family-name" defaultValue={state.fields.last_name} />
      </div>
      <Input id="email" label="Email" type="email" autoComplete="email" defaultValue={state.fields.email} />
      <Input
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint="At least 10 characters. A few words together is easier to remember and harder to guess."
      />
      <label htmlFor="age_attested" className="flex items-start gap-3 text-sm">
        <input id="age_attested" name="age_attested" type="checkbox" value="yes" required className="mt-0.5 h-5 w-5 shrink-0" />
        <span>I am 21 or older.</span>
      </label>
      <label htmlFor="marketing_email" className="flex items-start gap-3 text-sm">
        <input
          id="marketing_email"
          name="marketing_email"
          type="checkbox"
          value="yes"
          defaultChecked={state.fields.marketing_email === "yes"}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span>Email me offers and news. I can unsubscribe at any time. (Optional)</span>
      </label>
      <Problem state={state} />
      <Submit label="Create account" busy="Creating…" />
    </form>
  );
}

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action] = useActionState(verifyEmailAction.bind(null, token), EMPTY);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Problem state={state} />
      <Submit label="Confirm my email" busy="Confirming…" />
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(forgotPasswordAction, EMPTY);
  if (state.done) {
    return (
      <p role="status" className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-sm">
        If there&apos;s an account for {state.fields.email || "that address"}, we&apos;ve emailed a link to reset the
        password. It works for one hour.
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <Input id="email" label="Email" type="email" autoComplete="email" defaultValue={state.fields.email} />
      <Problem state={state} />
      <Submit label="Email me a reset link" busy="Sending…" />
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction.bind(null, token), EMPTY);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Input id="password" label="New password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." />
      <Input id="confirm" label="New password again" type="password" autoComplete="new-password" minLength={10} />
      <Problem state={state} />
      <Submit label="Set new password" busy="Saving…" />
    </form>
  );
}

export function ProfileForm({ customer }: { customer: ShopCustomerProfile }) {
  const [state, action] = useActionState(updateProfileAction, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id="first_name" label="First name" autoComplete="given-name" defaultValue={customer.first_name ?? ""} />
        <Input id="last_name" label="Last name" autoComplete="family-name" defaultValue={customer.last_name ?? ""} />
      </div>
      <Input id="phone" label="Phone" type="tel" autoComplete="tel" required={false} defaultValue={customer.phone ?? ""} />
      <p className="text-sm text-[var(--muted)]">
        Email: {customer.email}. To change it, call the shop.
      </p>
      <Problem state={state} />
      {state.done ? (
        <p role="status" className="text-sm text-[var(--ok)]">
          Saved.
        </p>
      ) : null}
      <Submit label="Save details" busy="Saving…" />
    </form>
  );
}

export function MarketingForm({ customer }: { customer: ShopCustomerProfile }) {
  const [state, action] = useActionState(setMarketingAction, EMPTY);
  const checked = state.done ? state.fields.marketing_email === "yes" : customer.marketing_email;
  return (
    <form action={action} className="flex flex-col gap-3">
      <label htmlFor="account_marketing_email" className="flex items-start gap-3 text-sm">
        <input
          id="account_marketing_email"
          name="marketing_email"
          type="checkbox"
          value="yes"
          defaultChecked={checked}
          key={String(checked)}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span>Email me offers and news. I can unsubscribe at any time.</span>
      </label>
      <Problem state={state} />
      {state.done ? (
        <p role="status" className="text-sm text-[var(--ok)]">
          Saved.
        </p>
      ) : null}
      <div>
        <button type="submit" className="btn btn-quiet text-sm">
          Save choice
        </button>
      </div>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, EMPTY);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Input id="current_password" label="Current password" type="password" autoComplete="current-password" />
      <Input id="new_password" label="New password" type="password" autoComplete="new-password" minLength={10} />
      <Input id="confirm" label="New password again" type="password" autoComplete="new-password" minLength={10} />
      <Problem state={state} />
      {state.done ? (
        <p role="status" className="text-sm text-[var(--ok)]">
          Password changed. You&apos;ve been signed out everywhere else.
        </p>
      ) : null}
      <Submit label="Change password" busy="Changing…" />
    </form>
  );
}
