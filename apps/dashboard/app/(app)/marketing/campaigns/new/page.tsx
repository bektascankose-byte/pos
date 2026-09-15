import { apiFetch } from "@/lib/api";
import type { Segment } from "@snappos/contracts";
import { NewCampaignClient } from "./NewCampaignClient";

export default async function NewCampaignPage() {
  const segments = await apiFetch<Segment[]>(`/api/v1/marketing/segments`).catch(() => []);
  return <NewCampaignClient segments={segments} />;
}
