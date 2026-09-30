"use client";

import { useActionState } from "react";
import { Icon } from "@/app/_components/icons";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [error, formAction, pending] = useActionState(loginAction, null);

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
          Your whole shop,
          <br />
          <span>one screen away.</span>
        </h2>
        <ul className="bo-login-points">
          <li><Icon name="trendUp" size={16} /> Live sales, profit and trends from every register</li>
          <li><Icon name="layers" size={16} /> Stock, receiving and invoices in one place</li>
          <li><Icon name="users" size={16} /> Customers, staff and schedules without the paperwork</li>
        </ul>
      </section>

      <section className="bo-login-panel">
        <div className="bo-login-card">
          <div className="bo-login-card-brand">
            <span className="bo-brand-mark"><Icon name="bolt" fill="currentColor" stroke="none" /></span>
          </div>
          <h1 className="bo-login-title">Welcome back</h1>
          <p className="bo-login-sub">Sign in to the SnapPOS Back Office.</p>

          <form action={formAction} className="bo-login-form">
            <label className="bo-login-label">
              Email
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                placeholder="you@yourshop.com"
                className="bo-login-input"
              />
            </label>
            <label className="bo-login-label">
              Password
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="Your password"
                className="bo-login-input"
              />
            </label>

            {error ? (
              <p className="bo-login-error" role="alert">
                <Icon name="alert" size={15} />
                {/* The API answers in lower case; a sentence reads better here. */}
                {error.charAt(0).toUpperCase() + error.slice(1)}
              </p>
            ) : null}

            <button type="submit" disabled={pending} className="bo-login-submit">
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
        <p className="bo-login-foot">SnapPOS Back Office · secured session</p>
      </section>
    </div>
  );
}
