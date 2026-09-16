"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { Order } from "@snappos/contracts";

/**
 * Every button on the queue funnels through here.
 *
 * One function rather than six, because the API already refuses a move that
 * the lifecycle does not allow and returns a sentence saying what is possible
 * instead. Re-checking that here would mean two descriptions of the same rule,
 * and the screen's copy would be the one that went stale.
 */
async function move(
  id: string,
  step: string,
  body?: Record<string, unknown>,
): Promise<ActionResult<Order>> {
  try {
    const data = await apiFetch<Order>(`/api/v1/orders/${id}/${step}`, {
      method: "POST",
      // A double-tap on a phone at a busy counter is one request the shop
      // meant, sent twice.
      headers: { "Idempotency-Key": randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    revalidatePath("/orders");
    revalidatePath(`/orders/${id}`);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not update that order." };
  }
}

export async function acceptOrderAction(id: string) {
  return move(id, "accept");
}

export async function prepareOrderAction(id: string) {
  return move(id, "preparing");
}

export async function readyOrderAction(id: string) {
  return move(id, "ready");
}

/**
 * Handover. The only one of these that moves stock, and the one that writes
 * the sale — which is why it asks how the customer paid rather than assuming.
 */
export async function completeOrderAction(id: string, tender: "cash" | "card" | "other") {
  return move(id, "complete", { tender });
}

export async function rejectOrderAction(id: string, reason: string) {
  if (!reason.trim()) return { ok: false as const, error: "Say why — the customer is told this." };
  return move(id, "reject", { reason: reason.trim() });
}

export async function cancelOrderAction(id: string, reason: string) {
  if (!reason.trim()) return { ok: false as const, error: "Say why — the customer is told this." };
  return move(id, "cancel", { reason: reason.trim() });
}

/** Take a line off an order that cannot be filled. Marked, never deleted. */
export async function removeOrderLineAction(
  id: string,
  lineId: string,
  reason: string,
): Promise<ActionResult<Order>> {
  if (!reason.trim()) return { ok: false, error: "Say why this line can't be filled." };
  try {
    const data = await apiFetch<Order>(`/api/v1/orders/${id}/lines/${lineId}/remove`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim() }),
    });
    revalidatePath(`/orders/${id}`);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that line." };
  }
}
