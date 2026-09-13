"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

export async function updateLoyaltySettingsAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const isActive = formData.get("is_active") === "on";
  const earnRate = String(formData.get("earn_points_per_dollar") ?? "").trim();
  const redemptionRate = String(formData.get("redemption_points_per_dollar") ?? "").trim();
  const minPoints = String(formData.get("minimum_redemption_points") ?? "").trim();
  const expireDays = String(formData.get("points_expire_after_days") ?? "").trim();

  if (!name || !earnRate || !redemptionRate) {
    redirect(`/loyalty?error=${encodeURIComponent("A name, an earn rate, and a redemption rate are required.")}`);
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
    await apiFetch(`/api/v1/loyalty/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save loyalty settings.";
    redirect(`/loyalty?error=${encodeURIComponent(message)}`);
  }
  redirect(`/loyalty?saved=1`);
}
