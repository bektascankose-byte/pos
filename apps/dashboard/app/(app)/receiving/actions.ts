"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { ActionResult } from "@/lib/action-result";
import type { ReceivingSession, ReceivingMatch } from "@snappos/contracts";

export async function createSessionAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = { store_id: String(formData.get("store_id") ?? "") };
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  if (vendorId) body.vendor_id = vendorId;
  const reference = String(formData.get("reference") ?? "").trim();
  if (reference) body.reference = reference;
  const note = String(formData.get("note") ?? "").trim();
  if (note) body.note = note;

  let created: ReceivingSession;
  try {
    created = await apiFetch<ReceivingSession>(`/api/v1/receiving`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not start that delivery.";
    redirect(`/receiving/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/receiving/${created.id}`);
}

/**
 * A pasted or scanned block of codes, one per line.
 *
 * Splitting happens here rather than on the server because what arrives is a
 * textarea's contents: a scanner's newlines, a person's stray blank lines, and
 * whatever the clipboard brought with it. The API takes a clean array.
 */
export async function bulkScanAction(id: string, text: string): Promise<ActionResult<ReceivingSession>> {
  const codes = text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (codes.length === 0) return { ok: false, error: "Scan or paste at least one code." };
  if (codes.length > 1000) return { ok: false, error: "That's more than 1,000 codes — split it up." };

  try {
    const data = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}/scan`, {
      method: "POST",
      body: JSON.stringify({ codes }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not record those scans." };
  }
}

export async function addLineAction(
  id: string,
  input: { code: string; quantity?: string; unit_cost?: string },
): Promise<ActionResult<ReceivingSession>> {
  const code = input.code.trim();
  if (!code) return { ok: false, error: "Scan or type a code." };

  try {
    const data = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}/lines`, {
      method: "POST",
      body: JSON.stringify({
        scanned_code: code,
        ...(input.quantity?.trim() ? { quantity: input.quantity.trim() } : {}),
        ...(input.unit_cost?.trim() ? { unit_cost: input.unit_cost.trim() } : {}),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that item." };
  }
}

export async function updateLineAction(
  id: string,
  lineId: string,
  input: { variant_id?: string; quantity?: string; unit_cost?: string },
): Promise<ActionResult<ReceivingSession>> {
  const body: Record<string, unknown> = {};
  if (input.variant_id) body.variant_id = input.variant_id;
  if (input.quantity?.trim()) body.quantity = input.quantity.trim();
  if (input.unit_cost?.trim()) body.unit_cost = input.unit_cost.trim();

  try {
    const data = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}/lines/${lineId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that line." };
  }
}

export async function removeLineAction(id: string, lineId: string): Promise<ActionResult<ReceivingSession>> {
  try {
    const data = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}/lines/${lineId}`, {
      method: "DELETE",
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that line." };
  }
}

/**
 * Create a product from a scan nothing matched.
 *
 * `price` is sent only when actually typed: left blank, the API takes the
 * price from the chosen price group, which is the whole reason to pick one
 * here rather than typing a number twice.
 */
export async function createProductForLineAction(
  id: string,
  lineId: string,
  input: {
    name: string;
    variant_name?: string;
    sku?: string;
    brand_id?: string;
    category_id?: string;
    price_group_id?: string;
    price?: string;
    cost?: string;
  },
): Promise<ActionResult<ReceivingSession>> {
  if (!input.name.trim()) return { ok: false, error: "Give the item a name." };

  const body: Record<string, unknown> = { name: input.name.trim() };
  for (const field of ["variant_name", "sku", "brand_id", "category_id", "price_group_id"] as const) {
    const value = input[field]?.trim();
    if (value) body[field] = value;
  }
  if (input.cost?.trim()) body.cost = input.cost.trim();

  if (input.price?.trim()) {
    const minor = parseMajorToMinor(input.price.trim());
    if (minor === null) return { ok: false, error: `"${input.price}" isn't a price.` };
    body.price_minor = minor;
  }

  try {
    const data = await apiFetch<ReceivingSession>(
      `/api/v1/receiving/${id}/lines/${lineId}/create-product`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create that item." };
  }
}

export async function commitSessionAction(id: string): Promise<ActionResult<ReceivingSession>> {
  try {
    const data = await apiFetch<ReceivingSession>(`/api/v1/receiving/${id}/commit`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not put this into stock." };
  }
}

/** Compare a parsed invoice with what was counted. Reads only. */
export async function matchInvoiceAction(
  id: string,
  invoiceImportId: string,
): Promise<ActionResult<ReceivingMatch>> {
  if (!invoiceImportId) return { ok: false, error: "Choose an invoice to check against." };
  try {
    const data = await apiFetch<ReceivingMatch>(`/api/v1/receiving/${id}/match-invoice`, {
      method: "POST",
      body: JSON.stringify({ invoice_import_id: invoiceImportId }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not check that invoice." };
  }
}
