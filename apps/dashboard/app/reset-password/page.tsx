"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/app/_components/icons";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { completePasswordResetAction } from "./actions";

/**
 * Choose a new password, using the token out of the emailed link.
 *
 * The token rides in the query string because it has to survive being clicked
 * from an email client, and it is put straight into a hidden field so it is
 * never typed or shown. It is single use and short lived, which is what makes
 * that acceptable.
 */
function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [outcome, formAction, pending] = useActionState(completePasswordResetAction, null);

  if (outcome?.ok) {
    return (
      <>
        <h1 className="bo-login-title">Password changed</h1>
        <p className="bo-login-sub">
          You are signed out everywhere else, so anyone still holding the old password is out too.
        </p>
        <a href="/login" className="bo-login-submit" style={{ display: "grid", placeItems: "center", textDecoration: "none" }}>
          Sign in
        </a>
      </>
    );
  }

  if (!token) {
    return (
      <>
        <h1 className="bo-login-title">That link is incomplete</h1>
        <p className="bo-login-sub">
          It is missing its code, which usually means the email client cut it short. Ask for a
          fresh one and open it in one click.
        </p>
        <a href="/forgot-password" className="bo-login-forgot">Send me a new link</a>
      </>
    );
  }

  return (
    <>
      <h1 className="bo-login-title">Choose a new password</h1>
      <p className="bo-login-sub">At least 8 characters. Nobody else ever sees it.</p>

      <form action={formAction} className="bo-login-form">
        <input type="hidden" name="token" value={token} />
        <label className="bo-login-label">
          New password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoFocus
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="bo-login-input"
          />
        </label>
        <label className="bo-login-label">
          Again, to be sure
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="The same password"
            className="bo-login-input"
          />
        </label>

        {outcome && !outcome.ok ? (
          <p className="bo-login-error" role="alert">
            <Icon name="alert" size={15} />
            {outcome.error}
          </p>
        ) : null}

        <button type="submit" disabled={pending} className="bo-login-submit">
          {pending ? "Saving…" : "Set my password"}
        </button>

        <a href="/login" className="bo-login-forgot">Back to sign in</a>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="bo-login">
      <div className="bo-login-theme">
        <ThemeToggle />
      </div>

      <section className="bo-login-hero" aria-hidden>
        <div className="bo-login-orb" />
        <div className="bo-login-brand">
          <span className="bo-brand-mark"><Icon name="bolt" fill="currentColor" stroke="none" /></span>
          <span className="bo-brand-name">SnapPOS</span>
        </div>
        <h2 className="bo-login-headline">
          Nearly there,
          <br />
          <span>one password to go.</span>
        </h2>
      </section>

      <section className="bo-login-panel">
        <div className="bo-login-card">
          <div className="bo-login-card-brand">
            <span className="bo-brand-mark"><Icon name="bolt" fill="currentColor" stroke="none" /></span>
          </div>
          {/* useSearchParams needs a boundary, or the whole route opts out of
              static rendering at build time. */}
          <Suspense fallback={<p className="bo-login-sub">Checking your link…</p>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
        <p className="bo-login-foot">SnapPOS Back Office · secured session</p>
      </section>
    </div>
  );
}
