"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

const MAX_LINES = 8;

export async function createVendorAction(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (!code || !name) {
    redirect(`/inventory/purchase-orders/new?error=${encodeURIComponent("A vendor code and name are required.")}`);
  }

  try {
    await apiFetch(`/api/v1/purchasing/vendors`, {
      method: "POST",
      body: JSON.stringify({
        code,
        name,
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
      }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create that vendor.";
    redirect(`/inventory/purchase-orders/new?error=${encodeURIComponent(message)}`);
  }
  redirect(`/inventory/purchase-orders/new?vendorSaved=1`);
}

export async function createPurchaseOrderAction(formData: FormData): Promise<void> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const vendorId = String(formData.get("vendor_id") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const expectedAt = String(formData.get("expected_at") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!storeId || !vendorId || !reference) {
    redirect(`/inventory/purchase-orders/new?error=${encodeURIComponent("A vendor and a reference are required.")}`);
  }

  const lines: { variant_id: string; quantity_ordered: string; unit_cost: string }[] = [];
  for (let i = 0; i < MAX_LINES; i++) {
    const variantId = String(formData.get(`variant_id_${i}`) ?? "").trim();
    const quantity = String(formData.get(`quantity_${i}`) ?? "").trim();
    const unitCost = String(formData.get(`unit_cost_${i}`) ?? "").trim();
    if (!variantId || !quantity || !unitCost) continue;
    lines.push({ variant_id: variantId, quantity_ordered: quantity, unit_cost: unitCost });
  }

  if (lines.length === 0) {
    redirect(`/inventory/purchase-orders/new?error=${encodeURIComponent("Add at least one line item.")}`);
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(`/api/v1/purchasing/purchase-orders`, {
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
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create the purchase order.";
    redirect(`/inventory/purchase-orders/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/inventory/purchase-orders/${created.id}?saved=1`);
}

export async function receivePurchaseOrderAction(poId: string, lineIds: string[], formData: FormData): Promise<void> {
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
    redirect(`/inventory/purchase-orders/${poId}?error=${encodeURIComponent("Enter a quantity for at least one line.")}`);
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
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not receive that shipment.";
    redirect(`/inventory/purchase-orders/${poId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/inventory/purchase-orders/${poId}?saved=1`);
}
