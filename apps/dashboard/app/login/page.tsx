"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [error, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">SnapPOS Back Office</h1>
        <p className="mb-6 text-sm text-[var(--color-text-muted)]">Sign in to continue.</p>

        <form action={formAction} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="username"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

          <button
            type="submit"
            disabled={pending}
            className="mt-2 rounded-md bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
