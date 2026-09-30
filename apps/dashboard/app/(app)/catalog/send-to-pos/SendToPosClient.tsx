"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { PosPending, PosPendingProduct, SendToPosResult } from "@snappos/contracts";
import { sendToPosAction, refreshPendingAction } from "./actions";

const KIND_LABEL: Record<PosPendingProduct["kind"], string> = {
  new: "New",
  changed: "Changed",
  removed: "Coming off",
};

/**
 * What is waiting for the registers, and the button that sends it.
 *
 * The page is a list of products rather than of fields, because that is the
 * unit a person thinks in and the unit the API sends in. Each row says what
 * will change on the till in words -- "Adds Honey Berry", "Price $6.55 to
 * $6.99" -- since the point of holding edits back is being able to read them
 * before a cashier does.
 *
 * Everything sendable starts ticked. The common case is a person who has just
 * finished a session of catalog work and wants all of it live; the rarer case
 * of sending one product is a matter of unticking the rest.
 */
export function SendToPosClient({ initial }: { initial: PosPending }) {
  const [pending, setPending] = useState(initial);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SendToPosResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, startTransition] = useTransition();

  const sendable = useMemo(() => pending.products.filter((p) => p.sendable), [pending.products]);
  const chosen = useMemo(
    () => sendable.filter((p) => !skipped.has(p.product_id)).map((p) => p.product_id),
    [sendable, skipped],
  );
  const blocked = pending.products.filter((p) => !p.sendable);

  const toggle = (productId: string) => {
    setSkipped((previous) => {
      const next = new Set(previous);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const reload = () => {
    startTransition(async () => {
      const refreshed = await refreshPendingAction();
      if (refreshed.ok) {
        setPending(refreshed.data);
        setSkipped(new Set());
      } else setError(refreshed.error);
    });
  };

  const send = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const sent = await sendToPosAction(chosen);
      if (!sent.ok) {
        setError(sent.error);
        return;
      }
      setResult(sent.data);
      const refreshed = await refreshPendingAction();
      if (refreshed.ok) {
        setPending(refreshed.data);
        setSkipped(new Set());
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Send to POS</h1>
          <p className="max-w-2xl text-sm text-[var(--color-text-muted)]">
            The registers sell what they were last sent. Edit the catalog as much as you like — names,
            flavors, barcodes, prices and photos only reach the tills when you send them here. Stock and
            cost are always live and never wait.
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={working}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Refresh
        </button>
      </header>

      {pending.last_release ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Last sent {new Date(pending.last_release.created_at).toLocaleString()}
          {pending.last_release.released_by ? ` by ${pending.last_release.released_by}` : ""} —{" "}
          {pending.last_release.product_count}{" "}
          {pending.last_release.product_count === 1 ? "item" : "items"}.
        </p>
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">Nothing has been sent from here yet.</p>
      )}

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      {result ? <SendSummary result={result} /> : null}

      {pending.products.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
          <p className="text-sm font-medium">Every register has the current catalog.</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Nothing is waiting to be sent.
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {pending.products.map((product) => (
              <PendingRow
                key={product.product_id}
                product={product}
                checked={product.sendable && !skipped.has(product.product_id)}
                disabled={working}
                onToggle={() => toggle(product.product_id)}
              />
            ))}
          </ul>

          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] py-3">
            <p className="text-xs text-[var(--color-text-muted)]">
              {chosen.length} of {sendable.length} ready{" "}
              {sendable.length === 1 ? "item" : "items"} selected
              {blocked.length > 0 ? `, ${blocked.length} not ready` : ""}.
            </p>
            <button
              type="button"
              onClick={send}
              disabled={working || chosen.length === 0}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
            >
              {working
                ? "Sending…"
                : `Send ${chosen.length} ${chosen.length === 1 ? "item" : "items"} to the registers`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PendingRow({
  product,
  checked,
  disabled,
  onToggle,
}: {
  product: PosPendingProduct;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || !product.sendable}
        onChange={onToggle}
        aria-label={`Send ${product.product_name}`}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-30"
      />

      <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-[var(--color-bg)]">
        {product.image_id ? (
          /* eslint-disable-next-line @next/next/no-img-element -- our own proxy, not a known-size remote */
          <img
            src={`/api/product-images/${product.image_id}?size=thumb`}
            alt=""
            className="h-full w-full object-contain"
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Link
            href={`/catalog/${product.product_id}`}
            className="truncate text-sm font-medium hover:underline"
          >
            {product.product_name}
          </Link>
          <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-[var(--color-text-muted)]">
            {KIND_LABEL[product.kind]}
          </span>
          {product.brand_name ? (
            <span className="text-xs text-[var(--color-text-muted)]">{product.brand_name}</span>
          ) : null}
        </div>

        <ul className="mt-1 flex flex-col gap-0.5">
          {product.changes.map((change, index) => (
            <li key={index} className="text-xs text-[var(--color-text-muted)]">
              {change}
            </li>
          ))}
        </ul>

        {product.problems.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {product.problems.map((problem, index) => (
              <li key={index} className="text-xs text-[var(--color-error)]">
                {problem}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/**
 * What the send actually did.
 *
 * Held-back flavours are listed individually rather than counted. A person who
 * pressed Send believes the shop is now selling these; the one line that says
 * otherwise has to name the item and the reason, or they find out at the
 * counter.
 */
function SendSummary({ result }: { result: SendToPosResult }) {
  const counts = [
    result.variants_added > 0 ? `${result.variants_added} added` : null,
    result.variants_changed > 0 ? `${result.variants_changed} updated` : null,
    result.variants_removed > 0 ? `${result.variants_removed} removed` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="text-sm font-medium">
        Sent {result.sent} {result.sent === 1 ? "item" : "items"} to the registers
        {counts.length > 0 ? ` — ${counts.join(", ")}.` : "."}
      </p>
      <p className="text-xs text-[var(--color-text-muted)]">
        Each register picks this up on its next sync, within about a minute.
      </p>

      {result.held_back.length > 0 ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
          <p className="text-xs font-medium text-[var(--color-error)]">
            {result.held_back.length} {result.held_back.length === 1 ? "flavor" : "flavors"} stayed
            behind and {result.held_back.length === 1 ? "is" : "are"} not on the registers:
          </p>
          <ul className="flex flex-col gap-0.5">
            {result.held_back.map((held, index) => (
              <li key={index} className="text-xs text-[var(--color-text-muted)]">
                <Link href={`/catalog/${held.product_id}`} className="underline">
                  {held.variant_name}
                </Link>{" "}
                — {held.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
