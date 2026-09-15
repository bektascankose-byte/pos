import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { Campaign } from "@snappos/contracts";

export default async function CampaignsPage() {
  let campaigns: Campaign[] = [];
  let error: string | null = null;
  try {
    campaigns = await apiFetch<Campaign[]>(`/api/v1/marketing/campaigns`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load campaigns.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Campaigns</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Email to a segment. Only customers who opted in are sent to.
          </p>
        </div>
        <Link
          href="/marketing/campaigns/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          New campaign
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Campaign</th>
              <th className="px-4 py-2 font-normal">To</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Sent</th>
              <th className="px-4 py-2 text-right font-normal">Skipped</th>
              <th className="px-4 py-2 font-normal">When</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/marketing/campaigns/${campaign.id}`} className="text-[var(--color-accent)]">
                    {campaign.name}
                  </Link>
                  {campaign.subject ? (
                    <div className="text-xs text-[var(--color-text-muted)]">{campaign.subject}</div>
                  ) : null}
                </td>
                <td className="px-4 py-2">{campaign.segment_name ?? "—"}</td>
                <td className="px-4 py-2">
                  <span
                    className={
                      campaign.status === "sent"
                        ? "text-[var(--color-success)]"
                        : campaign.status === "failed"
                          ? "text-[var(--color-error)]"
                          : "text-[var(--color-text-muted)]"
                    }
                  >
                    {campaign.status === "draft" ? "Not sent" : campaign.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {campaign.status === "draft" ? "—" : campaign.sent_count}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {campaign.status === "draft" ? "—" : campaign.skipped_count}
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {campaign.sent_at
                    ? new Date(campaign.sent_at).toLocaleDateString()
                    : new Date(campaign.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && !error ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No campaigns yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
