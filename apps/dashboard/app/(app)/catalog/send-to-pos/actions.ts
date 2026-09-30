"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { PosPending, SendToPosResult } from "@snappos/contracts";

/**
 * Send these products to the registers.
 *
 * Both halves come back: what went, and what stayed behind with the reason.
 * The page needs the second one as much as the first -- a send that quietly
 * left two flavours off the tills would be discovered at the counter.
 */
export async function sendToPosAction(productIds: string[]): Promise<ActionResult<SendToPosResult>> {
  if (productIds.length === 0) {
    return { ok: false, error: "Pick at least one item to send." };
  }

  try {
    const result = await apiFetch<SendToPosResult>(`/api/v1/catalog/pos-release/send`, {
      method: "POST",
      body: JSON.stringify({ product_ids: productIds }),
    });
    // The catalog pages show whether an item is on the registers, so they are
    // stale the moment this succeeds.
    revalidatePath("/catalog/send-to-pos");
    revalidatePath("/catalog");
    return { ok: true, data: result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError ? error.message : "Could not send to the registers.",
    };
  }
}

/** Re-read what is waiting, after a send or when someone presses Refresh. */
export async function refreshPendingAction(): Promise<ActionResult<PosPending>> {
  try {
    return { ok: true, data: await apiFetch<PosPending>(`/api/v1/catalog/pos-release/pending`) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ApiError ? error.message : "Could not check what is waiting.",
    };
  }
}
