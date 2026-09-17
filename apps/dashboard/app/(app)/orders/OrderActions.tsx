"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Order, OrderStatus } from "@snappos/contracts";
import { nextStatuses, readableStatus } from "@snappos/contracts";
import {
  acceptOrderAction,
  cancelOrderAction,
  completeOrderAction,
  prepareOrderAction,
  readyOrderAction,
  rejectOrderAction,
} from "./actions";

type Result = { ok: true; data: Order } | { ok: false; error: string };

/**
 * The buttons that move an order along.
 *
 * Which ones appear comes from `nextStatuses` — the same table the API checks
 * against — rather than from a list written out again here. A status this
 * screen offers is therefore a status the server will accept, and a lifecycle
 * change in one place cannot leave a dead button behind in the other.
 *
 * Handover asks how the customer paid, because until online payment exists a
 * pickup order is paid at the counter and the sale has to record which way --
 * and, for an order with age-restricted items, for confirmation that the ID was
 * checked. Rejecting and cancelling ask why, because the customer is shown that
 * sentence.
 */
export function OrderActions({
  id,
  status,
  minimumAge,
  compact = false,
}: {
  id: string;
  status: OrderStatus;
  /** The oldest age any line needs. When set, handover asks for the ID check first. */
  minimumAge: number | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<Result>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  };

  const ask = (verb: string) => {
    const reason = window.prompt(
      `Why is this order being ${verb}?\n\nThe customer is shown what you write here.`,
    );
    return reason?.trim() ? reason.trim() : null;
  };

  const available = new Set(nextStatuses(status));
  const size = compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const primary = `rounded-md bg-[var(--color-accent)] ${size} font-medium text-[var(--color-accent-contrast)] disabled:opacity-40`;
  const secondary = `rounded-md border border-[var(--color-border)] ${size} disabled:opacity-40`;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {available.has("accepted") ? (
          <button type="button" disabled={pending} className={primary} onClick={() => run(() => acceptOrderAction(id))}>
            Accept
          </button>
        ) : null}

        {available.has("preparing") ? (
          <button type="button" disabled={pending} className={secondary} onClick={() => run(() => prepareOrderAction(id))}>
            Preparing
          </button>
        ) : null}

        {available.has("ready") ? (
          <button type="button" disabled={pending} className={primary} onClick={() => run(() => readyOrderAction(id))}>
            Ready
          </button>
        ) : null}

        {available.has("completed") ? (
          <TenderPicker
            id={id}
            disabled={pending}
            minimumAge={minimumAge}
            onPick={(tender, idChecked) => run(() => completeOrderAction(id, tender, idChecked))}
            size={size}
          />
        ) : null}

        {available.has("rejected") ? (
          <button
            type="button"
            disabled={pending}
            className={secondary}
            onClick={() => {
              const reason = ask("rejected");
              if (reason) run(() => rejectOrderAction(id, reason));
            }}
          >
            Reject
          </button>
        ) : null}

        {available.has("cancelled") ? (
          <button
            type="button"
            disabled={pending}
            className={secondary}
            onClick={() => {
              const reason = ask("cancelled");
              if (reason) run(() => cancelOrderAction(id, reason));
            }}
          >
            Cancel
          </button>
        ) : null}

        {available.size === 0 ? (
          <span className="text-xs text-[var(--color-text-muted)]">
            {readableStatus(status)} — nothing further
          </span>
        ) : null}
      </div>
      {error ? <span className="text-xs text-[var(--color-error)]">{error}</span> : null}
    </div>
  );
}

/**
 * Hand over, and say how it was paid.
 *
 * Three buttons behind one, rather than three across the row: at the moment of
 * handover the cashier has already taken the money and needs one action, and a
 * row that reads "Cash  Card  Other" next to "Reject" invites the wrong tap.
 *
 * For an age-restricted order the tender buttons stay disabled until the ID
 * check is ticked. The website only took the customer's word for their age;
 * this is where it is actually checked, the same as for any counter sale.
 */
function TenderPicker({
  id,
  disabled,
  minimumAge,
  onPick,
  size,
}: {
  id: string;
  disabled: boolean;
  minimumAge: number | null;
  onPick: (tender: "cash" | "card" | "other", idChecked: boolean) => void;
  size: string;
}) {
  const [open, setOpen] = useState(false);
  const [idChecked, setIdChecked] = useState(false);
  const needsId = minimumAge !== null;

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        className={`rounded-md bg-[var(--color-accent)] ${size} font-medium text-[var(--color-accent-contrast)] disabled:opacity-40`}
        onClick={() => setOpen(true)}
      >
        Hand over
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1 rounded-md border border-[var(--color-border)] p-1">
      {needsId ? (
        <label className="inline-flex items-center gap-1.5 px-1 text-xs" htmlFor={`id-checked-${id}`}>
          <input
            id={`id-checked-${id}`}
            type="checkbox"
            checked={idChecked}
            onChange={(event) => setIdChecked(event.target.checked)}
          />
          Checked photo ID: {minimumAge}+
        </label>
      ) : null}
      <span className="pl-1 text-xs text-[var(--color-text-muted)]">Paid by</span>
      {(["cash", "card", "other"] as const).map((tender) => (
        <button
          key={tender}
          type="button"
          disabled={disabled || (needsId && !idChecked)}
          className={`rounded ${size} capitalize hover:bg-[var(--color-surface-muted)] disabled:opacity-40`}
          onClick={() => {
            setOpen(false);
            onPick(tender, idChecked);
            setIdChecked(false);
          }}
        >
          {tender}
        </button>
      ))}
      <button
        type="button"
        className="rounded px-1.5 py-1 text-xs text-[var(--color-text-muted)]"
        onClick={() => {
          setOpen(false);
          setIdChecked(false);
        }}
        aria-label="Cancel handover"
      >
        ✕
      </button>
    </span>
  );
}
