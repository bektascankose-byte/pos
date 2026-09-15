import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Campaign, CampaignRecipient, Segment, SegmentPreview } from "@snappos/contracts";
import { CampaignDetailClient } from "./CampaignDetailClient";

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let campaign: Campaign & { recipients: CampaignRecipient[] };
  try {
    campaign = await apiFetch<Campaign & { recipients: CampaignRecipient[] }>(
      `/api/v1/marketing/campaigns/${id}`,
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  // Counted live rather than read off the draft: who has opted in changes
  // between writing a campaign and sending it, and the number on the send
  // button has to be the one that will actually be used.
  let preview: SegmentPreview | null = null;
  if (campaign.status === "draft" && campaign.segment_id) {
    preview = await apiFetch<Segment>(`/api/v1/marketing/segments/${campaign.segment_id}`)
      .then((segment) =>
        apiFetch<SegmentPreview>(`/api/v1/marketing/segments/preview?channel=${campaign.channel}`, {
          method: "POST",
          body: JSON.stringify(segment.definition),
        }),
      )
      .catch(() => null);
  }

  return (
    <CampaignDetailClient campaign={campaign} recipients={campaign.recipients ?? []} preview={preview} />
  );
}
