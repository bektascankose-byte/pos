"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { ImportJob, ImportCommitResult } from "@snappos/contracts";

/**
 * Upload redirects rather than returning, because the review screen is a
 * page: the mapping, the dry run and the commit all happen against the job
 * that now exists, and a browser reload in the middle of reviewing a 4,000
 * row migration should land back on it rather than lose it.
 */
export async function uploadImportAction(formData: FormData): Promise<void> {
  const entity = String(formData.get("entity") ?? "").trim();
  const storeId = String(formData.get("store_id") ?? "").trim();
  const file = formData.get("file");

  const back = `/imports/new?entity=${encodeURIComponent(entity)}`;
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${back}&error=${encodeURIComponent("Choose a file to upload.")}`);
  }

  const upload = new FormData();
  upload.set("entity", entity);
  if (storeId) upload.set("store_id", storeId);
  upload.set("file", file, file.name);

  let created: ImportJob;
  try {
    created = await apiFetch<ImportJob>(`/api/v1/data-transfer/imports`, { method: "POST", body: upload });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not read that file.";
    redirect(`${back}&error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/imports/${created.id}`);
}

export async function setMappingAction(
  id: string,
  mapping: Record<string, string>,
  remember: boolean,
): Promise<ActionResult<ImportJob>> {
  try {
    const data = await apiFetch<ImportJob>(`/api/v1/data-transfer/imports/${id}/mapping`, {
      method: "POST",
      body: JSON.stringify({ mapping, remember }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that mapping." };
  }
}

/** Validates every row and reports what committing would do. Writes nothing. */
export async function dryRunAction(id: string): Promise<ActionResult<ImportJob>> {
  try {
    const data = await apiFetch<ImportJob>(`/api/v1/data-transfer/imports/${id}/dry-run`, { method: "POST" });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not check that file." };
  }
}

export async function commitImportAction(id: string): Promise<ActionResult<ImportCommitResult>> {
  try {
    const data = await apiFetch<ImportCommitResult>(`/api/v1/data-transfer/imports/${id}/commit`, {
      method: "POST",
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not run that import." };
  }
}
