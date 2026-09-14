"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { LoyaltySettings } from "@snappos/contracts";

export async function updateLoyaltySettingsAction(formData: FormData): Promise<ActionResult<LoyaltySettings>> {
  const name = String(formData.get("name") ?? "").trim();
  const isActive = formData.get("is_active") === "on";
  const earnRate = String(formData.get("earn_points_per_dollar") ?? "").trim();
  const redemptionRate = String(formData.get("redemption_points_per_dollar") ?? "").trim();
  const minPoints = String(formData.get("minimum_redemption_points") ?? "").trim();
  const expireDays = String(formData.get("points_expire_after_days") ?? "").trim();

  if (!name || !earnRate || !redemptionRate) {
    return { ok: false, error: "A name, an earn rate, and a redemption rate are required." };
  }

  const body: Record<string, unknown> = {
    name,
    is_active: isActive,
    earn_points_per_dollar: earnRate,
    redemption_points_per_dollar: redemptionRate,
  };
  if (minPoints) body.minimum_redemption_points = Number(minPoints);
  if (expireDays) body.points_expire_after_days = Number(expireDays);

  try {
    const data = await apiFetch<LoyaltySettings>(`/api/v1/loyalty/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save loyalty settings." };
  }
}
