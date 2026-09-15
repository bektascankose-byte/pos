"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendCampaignAction } from "../../actions";
import { unreachableReasons } from "../../reasons";
import type { Campaign, CampaignRecipient, SegmentPreview } from "@snappos/contracts";

/**
 * A campaign, and the button that sends it.
 *
 * Before sending, the screen shows how many the segment reaches *now* rather
 * than when the draft was written — every recipient is resolved against
 * consent and the suppression list at the moment of the send, so a customer
 * who unsubscribed yesterday is not mailed today by a week-old draft.
 *
 * After sending, the recipient list is the record of what happened, including
 * the people deliberately left out and why.
 */
export function CampaignDetailClient({
  campaign: initialCampaign,
  recipients,
  preview,
}: {
  campaign: Campaign;
  recipients: CampaignRecipient[];
  preview: SegmentPreview | null;
}) {
  const router = useRouter();
  const [campaign, setCampaign] = useState(initialCampaign);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const draft = campaign.status === "draft";

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await sendCampaignAction(campaign.id);
      if (result.ok) {
        setCampaign({ ...campaign, ...result.data });
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{campaign.name}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {campaign.segment_name ?? "no segment"} · {campaign.channel} ·{" "}
          {campaign.status === "draft" ? "not sent" : campaign.status}
          {campaign.sent_at ? ` · ${new Date(campaign.sent_at).toLocaleString()}` : ""}
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <section className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="text-sm font-medium">The message</h2>
        {campaign.subject ? <p className="text-sm font-medium">{campaign.subject}</p> : null}
        <pre className="whitespace-pre-wrap font-sans text-sm text-[var(--color-text-muted)]">{campaign.body}</pre>
      </section>

      {draft ? (
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-medium">Who this reaches</h2>
          {preview ? (
            <>
              <div className="flex flex-wrap gap-6">
                <Stat label="Match the segment" value={preview.matched} />
                <Stat label="Will be emailed" value={preview.reachable} tone="good" />
              </div>
              {preview.matched > preview.reachable ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {preview.matched - preview.reachable} won&apos;t be: {unreachableReasons(preview)}.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">Could not work out who this reaches.</p>
          )}

          <button
            type="button"
            disabled={pending || !preview || preview.reachable === 0}
            onClick={send}
            title={preview?.reachable === 0 ? "Nobody in this segment has opted in to email" : undefined}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending
              ? "Sending..."
              : preview
                ? `Send to ${preview.reachable} customer${preview.reachable === 1 ? "" : "s"}`
                : "Send"}
          </button>
          <p className="text-xs text-[var(--color-text-muted)]">
            This can&apos;t be undone — email doesn&apos;t come back.
          </p>
        </section>
      ) : (
        <section className="flex flex-wrap gap-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <Stat label="Sent" value={campaign.sent_count} tone="good" />
          <Stat label="Failed" value={campaign.failed_count} tone={campaign.failed_count > 0 ? "bad" : undefined} />
          <Stat label="Skipped" value={campaign.skipped_count} />
          <Stat label="Considered" value={campaign.recipient_count} />
        </section>
      )}

      {recipients.length > 0 ? (
        <section className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
            Recipients
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--color-text-muted)]">
              <tr>
                <th className="px-4 py-2 font-normal">Customer</th>
                <th className="px-4 py-2 font-normal">Email</th>
                <th className="px-4 py-2 font-normal">What happened</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => (
                <tr key={recipient.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">{recipient.customer_name}</td>
                  <td className="px-4 py-2">{recipient.address ?? "—"}</td>
                  <td className="px-4 py-2 text-[var(--color-text-muted)]">
                    {recipient.status === "sent" ? (
                      <span className="text-[var(--color-success)]">Sent</span>
                    ) : recipient.status === "failed" ? (
                      <span className="text-[var(--color-error)]">Failed — {recipient.error}</span>
                    ) : recipient.status === "skipped" ? (
                      `Skipped — ${recipient.skip_reason}`
                    ) : (
                      recipient.status
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-[var(--color-success)]" : tone === "bad" ? "text-[var(--color-error)]" : "";
  return (
    <div>
      <div className={`text-2xl tabular-nums ${color}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}
