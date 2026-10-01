"use server";

import { randomUUID } from "node:crypto";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { ActionResult } from "@/lib/action-result";

/**
 * The three things Quick edit writes, one call each, so a problem with one
 * (a barcode already on another item, say) shows against that box and never
 * undoes the others.
 */

/** How many singles come in one of this flavor's boxes. Only written when it changed. */
export async function quickUnitsPerBoxAction(variantId: string, units: number): Promise<ActionResult> {
  if (!Number.isInteger(units) || units < 1) {
    return { ok: false, error: "A box holds at least one." };
  }
  try {
    await apiFetch(`/api/v1/catalog/variants/${variantId}`, {
      method: "PATCH",
      body: JSON.stringify({ case_quantity: units }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save the box size." };
  }
}

/**
 * Record what is on the shelf as a count.
 *
 * Stock is a ledger, so this posts the difference between what was counted
 * and what the system holds right now, read fresh here rather than taken
 * from the page: the page may have been open while the till sold some.
 * Counting the same number twice posts nothing the second time, which is
 * what makes going back over a flavor safe.
 */
export async function quickCountAction(
  variantId: string,
  counted: number,
): Promise<ActionResult<{ onHand: string; delta: string }>> {
  if (!Number.isFinite(counted) || counted < 0) {
    return { ok: false, error: "That isn't a count." };
  }
  const storeId = await primaryStoreId();
  if (!storeId) return { ok: false, error: "No store is selected, so stock can't be counted." };

  try {
    const current = await apiFetch<{ on_hand: string }>(
      `/api/v1/inventory/stock/${variantId}?store_id=${storeId}`,
    );
    const delta = (Math.round((counted - Number(current.on_hand)) * 1000) / 1000).toString();
    if (Number(delta) !== 0) {
      await apiFetch(`/api/v1/inventory/movements`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          movements: [
            {
              store_id: storeId,
              variant_id: variantId,
              delta,
              reason: "count_adjustment",
              note: "Quick count",
            },
          ],
        }),
      });
    }
    return { ok: true, data: { onHand: String(counted), delta } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not record that count." };
  }
}

/**
 * Add a scanned code. A single's kind is read off its length the way a
 * scanner's symbology would be; a box code is always `case` and rings up
 * `units` singles.
 */
export async function quickBarcodeAction(
  variantId: string,
  code: string,
  which: "unit" | "carton",
  units: number,
): Promise<ActionResult> {
  const barcode = code.trim();
  if (!barcode) return { ok: false, error: "Nothing was scanned." };
  if (which === "carton" && (!Number.isInteger(units) || units < 2)) {
    return { ok: false, error: "Set how many singles come in a box before scanning the box code." };
  }
  const kind =
    which === "carton"
      ? "case"
      : /^\d{12}$/.test(barcode) || /^\d{8}$/.test(barcode)
        ? "upc"
        : /^\d{13}$/.test(barcode)
          ? "ean"
          : "custom";
  try {
    await apiFetch(`/api/v1/catalog/variants/${variantId}/barcodes`, {
      method: "POST",
      body: JSON.stringify({ barcode, kind, units: which === "carton" ? String(units) : "1" }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that code." };
  }
}
