"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createCampaignAction } from "../../actions";
import type { Segment } from "@snappos/contracts";

/**
 * Composing a campaign. Creating it never sends it — the send has its own
 * screen, its own button and its own permission, for the same reason
 * importing a spreadsheet does: the irreversible step gets a deliberate
 * click of its own.
 */
export function NewCampaignClient({ segments }: { segments: Segment[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (segments.length === 0) {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <h1 className="text-xl font-semibold">New campaign</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          A campaign goes to a segment, and there aren&apos;t any yet.
        </p>
        <Link href="/marketing/segments/new" className="text-sm text-[var(--color-accent)] underline">
          Create a segment first
        </Link>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">New campaign</h1>
      <p className="text-sm text-[var(--color-text-muted)]">
        Saving this creates a draft. Nothing is sent until you send it from the campaign&apos;s own page,
        where you&apos;ll see exactly who it reaches.
      </p>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <form
        className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const formData = new FormData(e.currentTarget);
          startTransition(async () => {
            const result = await createCampaignAction(formData);
            if (result.ok) router.push(`/marketing/campaigns/${result.data.id}`);
            else setError(result.error);
          });
        }}
      >
        {/* Email only, for now. Promotional SMS is refused by the API for
            tobacco and vape retail whatever the consent says -- see the note
            below -- so offering the choice would only produce a campaign that
            cannot be sent. */}
        <input type="hidden" name="channel" value="email" />

        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="name"
            required
            placeholder="October vape restock"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">For you, not the customer.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Send to
          <select
            name="segment_id"
            required
            defaultValue=""
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Choose a segment
            </option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Subject
          <input
            name="subject"
            required
            placeholder="Your flavour is back in stock"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Message
          <textarea
            name="body"
            required
            rows={10}
            defaultValue={"Hi {{first_name}},\n\n"}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {"{{first_name}}"} and {"{{shop_name}}"} get filled in. An unsubscribe link is added to every
            message automatically — it has to be there, and it has to work.
          </span>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save draft"}
        </button>
      </form>

      <p className="rounded-lg border border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
        Email only. US carriers block tobacco and vape promotions on business texting regardless of who
        opted in, so a promotional SMS would be filtered rather than delivered. Texts stay transactional —
        receipts and order notices.
      </p>
    </div>
  );
}
