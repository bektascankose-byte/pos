"use client";

import { useState, useTransition } from "react";
import { unsubscribeAction } from "./actions";

export function UnsubscribeClient({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const [pending, startTransition] = useTransition();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-12">
      {state === "done" ? (
        <>
          <h1 className="text-xl font-semibold">You&apos;re unsubscribed</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            You won&apos;t get marketing email from us again. Receipts and order updates for things you
            buy will still come through.
          </p>
        </>
      ) : state === "error" ? (
        <>
          <h1 className="text-xl font-semibold">That link didn&apos;t work</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            It may have already been used. If you&apos;re still getting email you don&apos;t want, reply
            to any of it and we&apos;ll take you off the list by hand.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Stop these emails?</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            You&apos;ll stop receiving marketing email. Receipts and order updates still come through.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await unsubscribeAction(token);
                setState(result.ok ? "done" : "error");
              })
            }
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {pending ? "Working..." : "Unsubscribe me"}
          </button>
        </>
      )}
    </main>
  );
}
