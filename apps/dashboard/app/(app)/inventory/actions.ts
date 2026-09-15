"use server";

import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { SearchRow } from "../catalog/types";

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

/**
 * A scanned or typed code to the variant it belongs to.
 *
 * Uses the back office's own `resolve` rather than `scan`: `scan` is the
 * register's path and deliberately refuses an item with no price, which is
 * precisely the sort of item someone is most likely to be standing in front
 * of with a clipboard.
 */
export async function resolveCodeAction(
  code: string,
): Promise<ActionResult<{ variant_id: string }>> {
  try {
    const result = await apiFetch<{ match: { variant_id: string } | null }>(
      `/api/v1/catalog/resolve/${encodeURIComponent(code)}`,
    );
    if (!result.match) {
      return { ok: false, error: `Nothing in the catalog matches "${code}".` };
    }
    return { ok: true, data: { variant_id: result.match.variant_id } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not look that code up." };
  }
}

/**
 * The catalog row for one item, so the inventory list's Edit button can open
 * the same editor the catalog list uses.
 *
 * Fetched on demand rather than loading the whole catalog alongside the stock
 * list: two lists of the same items on one page is two things to keep in
 * agreement, and only the row actually being edited needs the extra columns.
 */
export async function catalogRowForSkuAction(sku: string): Promise<ActionResult<SearchRow>> {
  try {
    const result = await apiFetch<{ data: SearchRow[] }>(
      `/api/v1/catalog/products?q=${encodeURIComponent(sku)}&limit=50`,
    );
    const row = result.data.find((candidate) => candidate.sku === sku);
    if (!row) return { ok: false, error: "Could not find that item in the catalog." };
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not load that item." };
  }
}
