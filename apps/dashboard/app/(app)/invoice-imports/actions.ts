"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

interface CreatedInvoiceImport {
  id: string;
}

export async function uploadInvoiceAction(formData: FormData): Promise<void> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(`/invoice-imports/new?error=${encodeURIComponent("Choose a file to upload.")}`);
  }

  const upload = new FormData();
  upload.set("store_id", storeId);
  upload.set("file", file, file.name);

  let created: CreatedInvoiceImport;
  try {
    created = await apiFetch<CreatedInvoiceImport>(`/api/v1/invoice-imports`, {
      method: "POST",
      body: upload,
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not upload that file.";
    redirect(`/invoice-imports/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/invoice-imports/${created.id}?saved=1`);
}

export async function parseInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/parse`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not parse that invoice.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function matchInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/match`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not match those lines.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}
