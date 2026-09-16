"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { removeOrderLineAction } from "../actions";

/**
 * Take a line off an order that cannot be filled.
 *
 * Asks for a reason and will not proceed without one, because the line is not
 * deleted — it stays on the order, struck through, with whatever is typed here
 * shown next to it. "Out of stock" is a sentence the customer reads.
 */
export function RemoveLineButton({
  orderId,
  lineId,
  label,
}: {
  orderId: string;
  lineId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs disabled:opacity-40"
        onClick={() => {
          const reason = window.prompt(
            `Why can't "${label}" be filled?\n\nThe line stays on the order with this next to it, and the customer sees it.`,
            "Out of stock",
          );
          if (!reason?.trim()) return;
          setError(null);
          startTransition(async () => {
            const result = await removeOrderLineAction(orderId, lineId, reason.trim());
            if (result.ok) router.refresh();
            else setError(result.error);
          });
        }}
      >
        {pending ? "Working…" : "Can't fill"}
      </button>
      {error ? <span className="text-xs text-[var(--color-error)]">{error}</span> : null}
    </span>
  );
}
