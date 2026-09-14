"use server";

import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

export async function postAdjustmentAction(
  variantId: string,
  storeId: string,
  formData: FormData,
): Promise<ActionResult> {
  const reason = String(formData.get("reason") ?? "").trim();
  const delta = String(formData.get("delta") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!reason || !delta) {
    return { ok: false, error: "A reason and a quantity are required." };
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
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not post that adjustment." };
  }
}
