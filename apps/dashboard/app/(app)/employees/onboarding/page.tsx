import { apiFetch, ApiError } from "@/lib/api";
import type { OnboardingTaskTemplate } from "@snappos/contracts";
import { OnboardingTemplateClient } from "./OnboardingTemplateClient";

export default async function OnboardingTemplatePage() {
  let items: OnboardingTaskTemplate[] = [];
  let loadError: string | null = null;
  try {
    items = await apiFetch<OnboardingTaskTemplate[]>(`/api/v1/onboarding/templates`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load the onboarding checklist template.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return <OnboardingTemplateClient initialItems={items} />;
}
