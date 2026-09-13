"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

const SPLIT_ROWS = 6;

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

export async function resolveLineAction(id: string, lineId: string, formData: FormData): Promise<void> {
  const variantId = String(formData.get("variant_id") ?? "").trim();
  if (!variantId) {
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent("Pick a variant before resolving this line.")}`);
  }
  const isNewProduct = formData.get("is_new_product") === "on";

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, ...(isNewProduct ? { is_new_product: true } : {}) }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not resolve that line.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function ignoreLineAction(id: string, lineId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/ignore`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not ignore that line.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function splitLineAction(id: string, lineId: string, formData: FormData): Promise<void> {
  const items: { variant_id: string; quantity: string; unit_cost?: string }[] = [];
  for (let i = 0; i < SPLIT_ROWS; i++) {
    const variantId = String(formData.get(`variant_id_${i}`) ?? "").trim();
    const quantity = String(formData.get(`quantity_${i}`) ?? "").trim();
    const unitCost = String(formData.get(`unit_cost_${i}`) ?? "").trim();
    if (!variantId || !quantity) continue;
    items.push({ variant_id: variantId, quantity, ...(unitCost ? { unit_cost: unitCost } : {}) });
  }

  if (items.length < 2) {
    redirect(
      `/invoice-imports/${id}/lines/${lineId}/split?error=${encodeURIComponent("Pick a variant and quantity for at least two rows.")}`,
    );
  }

  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/lines/${lineId}/split`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not split that line.";
    redirect(`/invoice-imports/${id}/lines/${lineId}/split?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}

export async function commitInvoiceAction(id: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/invoice-imports/${id}/commit`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not commit this invoice.";
    redirect(`/invoice-imports/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/invoice-imports/${id}?saved=1`);
}
