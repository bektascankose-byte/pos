"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { commitSessionAction, unverifySessionAction } from "./actions";
import type { ReceivingSession } from "@snappos/contracts";

/**
 * The one switch that decides whether a counted delivery is stock.
 *
 * Verify posts the count into inventory; unverify takes it back out and
 * returns the delivery to Counting so it can be corrected. Unverify is not an
 * undo in the sense of erasing history — the ledger keeps the movement in and
 * the movement back out, because both of them happened. What it undoes is the
 * *effect* on what is on the shelf.
 *
 * Unverify asks first. Verify does not: putting a count into stock is the
 * expected end of a delivery and is immediately reversible by this same
 * button, whereas taking stock back out is a surprise to anyone else looking
 * at the shelf figure.
 */
export function VerifyButton({ session }: { session: ReceivingSession }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (session.status === "cancelled") return null;

  const verified = session.status === "committed";
  const blocked = !verified && (session.line_count === 0 || session.unresolved_count > 0);

  const run = (action: () => Promise<{ ok: true; data: ReceivingSession } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || blocked}
        onClick={() => {
          if (verified) {
            const ok = window.confirm(
              `Take "${session.reference || "this delivery"}" back out of stock?\n\n` +
                `${session.line_count} line${session.line_count === 1 ? "" : "s"} will be removed from your ` +
                `shelf figures so you can change them. Nothing is deleted — the movement in and the movement ` +
                `back out both stay on the record. Verify again when you're done.`,
            );
            if (!ok) return;
            run(() => unverifySessionAction(session.id));
          } else {
            run(() => commitSessionAction(session.id));
          }
        }}
        title={
          blocked
            ? session.line_count === 0
              ? "Nothing has been scanned into this delivery yet"
              : `${session.unresolved_count} scanned code${session.unresolved_count === 1 ? "" : "s"} still need naming`
            : verified
              ? "Take this back out of stock so it can be edited"
              : "Put this delivery into stock"
        }
        className={
          verified
            ? "rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
            : "rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
        }
      >
        {pending ? "Working..." : verified ? "Unverify" : "Verify"}
      </button>
      {error ? <span className="text-xs text-[var(--color-error)]">{error}</span> : null}
    </div>
  );
}
