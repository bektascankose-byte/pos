"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

export async function postAdjustmentAction(
  variantId: string,
  storeId: string,
  formData: FormData,
): Promise<void> {
  const reason = String(formData.get("reason") ?? "").trim();
  const delta = String(formData.get("delta") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!reason || !delta) {
    redirect(`/inventory/${variantId}?error=${encodeURIComponent("A reason and a quantity are required.")}`);
  }

  try {
    await apiFetch(`/api/v1/inventory/movements`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        movements: [
          {
            store_id: storeId,
            variant_id: variantId,
            delta,
            reason,
            ...(note ? { note } : {}),
          },
        ],
      }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not post that adjustment.";
    redirect(`/inventory/${variantId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/inventory/${variantId}?saved=1`);
}
