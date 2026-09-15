"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type {
  Segment,
  SegmentPreview,
  SegmentDefinition,
  Campaign,
  CampaignSendResult,
} from "@snappos/contracts";

/**
 * A segment definition as the form holds it: everything a string, because
 * that is what an `<input>` gives back. Empty means "not part of this
 * segment" and is dropped rather than sent as 0 -- a `min_visits` of zero
 * would be a filter that matches everyone while looking like a real rule.
 */
export interface SegmentFormValues {
  bought_product_id?: string;
  bought_category_id?: string;
  within_days?: string;
  not_seen_days?: string;
  min_lifetime_spend?: string;
  min_visits?: string;
  has_tag?: string;
}

function toDefinition(values: SegmentFormValues): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  if (values.bought_product_id) definition.bought_product_id = values.bought_product_id;
  if (values.bought_category_id) definition.bought_category_id = values.bought_category_id;
  for (const key of ["within_days", "not_seen_days", "min_visits"] as const) {
    const raw = values[key]?.trim();
    if (raw) definition[key] = Number(raw);
  }
  if (values.has_tag?.trim()) definition.has_tag = values.has_tag.trim();

  // Dollars in the box, minor units on the wire -- nobody types a spend
  // threshold in cents.
  const spend = values.min_lifetime_spend?.trim().replace(/[$,]/g, "");
  if (spend && /^\d+(\.\d{1,2})?$/.test(spend)) {
    const [whole, fraction = ""] = spend.split(".");
    definition.min_lifetime_spend_minor = `${whole}${fraction.padEnd(2, "0")}`;
  }
  return definition;
}

export async function previewSegmentAction(
  values: SegmentFormValues,
  channel: "email" | "sms",
): Promise<ActionResult<SegmentPreview>> {
  try {
    const data = await apiFetch<SegmentPreview>(
      `/api/v1/marketing/segments/preview?channel=${channel}`,
      { method: "POST", body: JSON.stringify(toDefinition(values)) },
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not work that out." };
  }
}

export async function createSegmentAction(
  name: string,
  description: string,
  values: SegmentFormValues,
): Promise<ActionResult<Segment>> {
  if (!name.trim()) return { ok: false, error: "Give this segment a name." };
  try {
    const data = await apiFetch<Segment>(`/api/v1/marketing/segments`, {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        definition: toDefinition(values),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that segment." };
  }
}

export async function updateSegmentAction(
  id: string,
  name: string,
  description: string,
  values: SegmentFormValues,
): Promise<ActionResult<Segment>> {
  try {
    const data = await apiFetch<Segment>(`/api/v1/marketing/segments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        definition: toDefinition(values),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that segment." };
  }
}

export async function deleteSegmentAction(id: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/marketing/segments/${id}`, { method: "DELETE" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not delete that segment." };
  }
}

export async function createCampaignAction(formData: FormData): Promise<ActionResult<Campaign>> {
  const body = {
    name: String(formData.get("name") ?? "").trim(),
    channel: String(formData.get("channel") ?? "email"),
    segment_id: String(formData.get("segment_id") ?? "").trim(),
    subject: String(formData.get("subject") ?? "").trim(),
    body: String(formData.get("body") ?? "").trim(),
  };
  if (!body.segment_id) return { ok: false, error: "Choose who this goes to." };

  try {
    const data = await apiFetch<Campaign>(`/api/v1/marketing/campaigns`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that campaign." };
  }
}

/**
 * Sending is its own action and its own permission. Every recipient is
 * resolved against consent and the suppression list at this moment, not when
 * the campaign was written — so a customer who opted out yesterday is not
 * mailed today by a draft composed last week.
 */
export async function sendCampaignAction(id: string): Promise<ActionResult<CampaignSendResult>> {
  try {
    const data = await apiFetch<CampaignSendResult>(`/api/v1/marketing/campaigns/${id}/send`, {
      method: "POST",
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not send that campaign." };
  }
}

export type { SegmentDefinition };
