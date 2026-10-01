"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiFetchRaw, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

export interface LogoCandidates {
  /** True when the brand already has a logo and keeps it. */
  kept: boolean;
  /** Image addresses, best first, each with the page it is credited to. */
  candidates: { url: string; source: string }[];
}

/**
 * Where a brand's logo might be, found with AI.
 *
 * Slow on purpose: the API searches the web and reads the brand's own site.
 * The browser then fetches, checks and uploads the one it keeps; see
 * `findBrandLogo`.
 */
export async function findBrandLogoCandidatesAction(
  brandId: string,
  replace: boolean,
): Promise<ActionResult<LogoCandidates>> {
  try {
    const data = await apiFetch<LogoCandidates>(`/api/v1/catalog/brands/${brandId}/logo/candidates`, {
      method: "POST",
      body: JSON.stringify({ replace }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not look for a logo." };
  }
}

/** Keep an image as a brand's logo: one picked by hand, or a prepared find with its `source_url`. */
export async function uploadBrandLogoAction(brandId: string, formData: FormData): Promise<ActionResult<{ logoId: string }>> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Pick an image first." };
  }
  const forwarded = new FormData();
  forwarded.set("file", file);
  const source = String(formData.get("source_url") ?? "").trim();
  if (source) forwarded.set("source_url", source);
  try {
    const response = await apiFetchRaw(`/api/v1/catalog/brands/${brandId}/logo`, {
      method: "POST",
      body: forwarded,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: body?.user_message ?? body?.message ?? "Could not save that logo." };
    }
    revalidatePath("/catalog/brands");
    return { ok: true, data: { logoId: body.logo.id as string } };
  } catch {
    return { ok: false, error: "Could not save that logo." };
  }
}

export async function removeBrandLogoAction(brandId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/catalog/brands/${brandId}/logo`, { method: "DELETE" });
    revalidatePath("/catalog/brands");
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that logo." };
  }
}
