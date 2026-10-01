"use client";

import { useActionState, useState } from "react";
import { Icon } from "@/app/_components/icons";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { requestPasswordResetAction } from "./actions";

/**
 * Ask for a reset link.
 *
 * The confirmation never says whether that address has an account, because
 * the API will not say either and a page that did would be the easy way to
 * find out who banks here. It is worded so that somebody who mistyped their
 * own address still knows what to do next.
 */
export default function ForgotPasswordPage() {
  const [error, formAction, pending] = useActionState(requestPasswordResetAction, null);
  const [sent, setSent] = useState(false);

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
          Locked out?
          <br />
          <span>Back in a minute.</span>
        </h2>
      </section>

      <section className="bo-login-panel">
        <div className="bo-login-card">
          <div className="bo-login-card-brand">
            <span className="bo-brand-mark"><Icon name="bolt" fill="currentColor" stroke="none" /></span>
          </div>

          {sent ? (
            <>
              <h1 className="bo-login-title">Check your email</h1>
              <p className="bo-login-sub">
                If that address has a SnapPOS account, a link to set a new password is on its way.
                It works once and stops working in an hour.
              </p>
              <p className="bo-login-sub">
                Nothing arrived? Look in spam, then try again with the address you sign in with.
              </p>
              <a href="/login" className="bo-login-forgot">Back to sign in</a>
            </>
          ) : (
            <>
              <h1 className="bo-login-title">Reset your password</h1>
              <p className="bo-login-sub">
                Type the email you sign in with and we will send you a link.
              </p>

              <form
                action={(formData) => {
                  formAction(formData);
                  // Shown as soon as it is handed over rather than on a reply,
                  // because the reply is deliberately the same either way.
                  if (String(formData.get("email") ?? "").trim()) setSent(true);
                }}
                className="bo-login-form"
              >
                <label className="bo-login-label">
                  Email
                  <input
                    name="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="username"
                    placeholder="you@yourshop.com"
                    className="bo-login-input"
                  />
                </label>

                {error ? (
                  <p className="bo-login-error" role="alert">
                    <Icon name="alert" size={15} />
                    {error}
                  </p>
                ) : null}

                <button type="submit" disabled={pending} className="bo-login-submit">
                  {pending ? "Sending…" : "Email me a link"}
                </button>

                <a href="/login" className="bo-login-forgot">Back to sign in</a>
              </form>
            </>
          )}
        </div>
        <p className="bo-login-foot">SnapPOS Back Office · secured session</p>
      </section>
    </div>
  );
}
