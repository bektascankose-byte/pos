"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { StorefrontClient } from "@snappos/contracts";
import { createShopKeyAction, revokeShopKeyAction } from "./actions";

export function ShopKeys({ keys, storeId }: { keys: StorefrontClient[]; storeId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      {fresh ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface)] p-4"
        >
          <p className="text-sm font-medium">Copy the key for “{fresh.name}” now. It won&apos;t be shown again.</p>
          <code className="block break-all rounded-md bg-[var(--color-bg)] px-3 py-2 font-mono text-sm">{fresh.key}</code>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs"
              onClick={() => void navigator.clipboard?.writeText(fresh.key)}
            >
              Copy
            </button>
            <button
              type="button"
              className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs"
              onClick={() => setFresh(null)}
            >
              I&apos;ve saved it
            </button>
          </div>
        </div>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await createShopKeyAction(storeId, name);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setFresh({ name: result.data.client.name, key: result.data.key });
            setName("");
            router.refresh();
          });
        }}
      >
        <label className="flex flex-col gap-1 text-sm" htmlFor="shop-key-name">
          <span className="text-[var(--color-text-muted)]">Where it will be used</span>
          <input
            id="shop-key-name"
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5"
            placeholder="Main website"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-40"
        >
          {pending ? "Creating…" : "Create key"}
        </button>
        {error ? <span className="text-sm text-[var(--color-error)]">{error}</span> : null}
      </form>

      {keys.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No keys yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Starts with</th>
                <th className="px-3 py-2 font-normal">Created</th>
                <th className="px-3 py-2 font-normal">Last used</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <KeyRow key={key.id} shopKey={key} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KeyRow({ shopKey }: { shopKey: StorefrontClient }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const revoked = shopKey.revoked_at !== null;

  return (
    <tr className={`border-t border-[var(--color-border)] ${revoked ? "text-[var(--color-text-muted)]" : ""}`}>
      <td className="px-3 py-2">{shopKey.name}</td>
      <td className="px-3 py-2 font-mono text-xs">{shopKey.key_prefix}…</td>
      <td className="px-3 py-2">{new Date(shopKey.created_at).toLocaleDateString()}</td>
      <td className="px-3 py-2">
        {shopKey.last_used_at ? new Date(shopKey.last_used_at).toLocaleString() : "Never"}
      </td>
      <td className="px-3 py-2 text-right">
        {revoked ? (
          <span className="text-xs">Revoked {new Date(shopKey.revoked_at!).toLocaleDateString()}</span>
        ) : (
          <button
            type="button"
            disabled={pending}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-40"
            onClick={() => {
              const ok = window.confirm(
                `Revoke "${shopKey.name}"?\n\nAny website using it stops working straight away, until it is given a new key.`,
              );
              if (!ok) return;
              setError(null);
              startTransition(async () => {
                const result = await revokeShopKeyAction(shopKey.id);
                if (result.ok) router.refresh();
                else setError(result.error);
              });
            }}
          >
            Revoke
          </button>
        )}
        {error ? <div className="text-xs text-[var(--color-error)]">{error}</div> : null}
      </td>
    </tr>
  );
}
