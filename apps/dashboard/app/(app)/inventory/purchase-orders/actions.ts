"use server";

import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

export async function createVendorAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (!code || !name) {
    return { ok: false, error: "A vendor code and name are required." };
  }

  try {
    const data = await apiFetch<{ id: string }>(`/api/v1/purchasing/vendors`, {
      method: "POST",
      body: JSON.stringify({
        code,
        name,
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create that vendor." };
  }
}

/**
 * `lineCount` is however many line rows the client actually rendered (its
 * own "Add another line" click count) -- a blank row (no variant, qty, or
 * cost) is simply skipped, same as the old fixed count of 8 always was.
 */
export async function createPurchaseOrderAction(formData: FormData, lineCount: number): Promise<ActionResult<{ id: string }>> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const expectedAt = String(formData.get("expected_at") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!storeId || !vendorId || !reference) {
    return { ok: false, error: "A vendor and a reference are required." };
  }

  const lines: { variant_id: string; quantity_ordered: string; unit_cost: string }[] = [];
  for (let i = 0; i < lineCount; i++) {
    const variantId = String(formData.get(`variant_id_${i}`) ?? "").trim();
    const quantity = String(formData.get(`quantity_${i}`) ?? "").trim();
    const unitCost = String(formData.get(`unit_cost_${i}`) ?? "").trim();
    if (!variantId || !quantity || !unitCost) continue;
    lines.push({ variant_id: variantId, quantity_ordered: quantity, unit_cost: unitCost });
  }

  if (lines.length === 0) {
    return { ok: false, error: "Add at least one line item." };
  }

  try {
    const data = await apiFetch<{ id: string }>(`/api/v1/purchasing/purchase-orders`, {
      method: "POST",
      body: JSON.stringify({
        store_id: storeId,
        vendor_id: vendorId,
        reference,
        ...(expectedAt ? { expected_at: expectedAt } : {}),
        ...(note ? { note } : {}),
        lines,
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create the purchase order." };
  }
}

export async function receivePurchaseOrderAction(poId: string, lineIds: string[], formData: FormData): Promise<ActionResult> {
  const vendorInvoiceNo = String(formData.get("vendor_invoice_no") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  const lines: { po_line_id: string; quantity_received: string; unit_cost?: string }[] = [];
  for (const lineId of lineIds) {
    const qty = String(formData.get(`qty_${lineId}`) ?? "").trim();
    const cost = String(formData.get(`cost_${lineId}`) ?? "").trim();
    if (!qty || Number(qty) <= 0) continue;
    lines.push({ po_line_id: lineId, quantity_received: qty, ...(cost ? { unit_cost: cost } : {}) });
  }

  if (lines.length === 0) {
    return { ok: false, error: "Enter a quantity for at least one line." };
  }

  try {
    await apiFetch(`/api/v1/purchasing/purchase-orders/${poId}/receive`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        ...(vendorInvoiceNo ? { vendor_invoice_no: vendorInvoiceNo } : {}),
        ...(note ? { note } : {}),
        lines,
      }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not receive that shipment." };
  }
}
