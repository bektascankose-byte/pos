import { apiFetch, ApiError } from "@/lib/api";
import type { LoyaltySettings } from "@snappos/contracts";
import { LoyaltySettingsClient } from "./LoyaltySettingsClient";

export default async function LoyaltySettingsPage() {
  let settings: LoyaltySettings | null = null;
  let loadError: string | null = null;
  try {
    settings = await apiFetch<LoyaltySettings>(`/api/v1/loyalty/settings`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load loyalty settings.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }
  if (!settings) return null;

  return <LoyaltySettingsClient initialSettings={settings} />;
}
