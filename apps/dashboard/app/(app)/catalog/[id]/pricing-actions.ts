"use server";

import { apiFetch, ApiError } from "@/lib/api";
import { parseMajorToMinor } from "@/lib/money";
import type { ActionResult } from "@/lib/action-result";

/** What "All flavors" on the Cost & Margin tab can set. Blank or missing means leave each flavor's own. */
export interface AllFlavorsFields {
  case_quantity?: string;
  case_cost?: string;
  case_discount?: string;
  case_rebate?: string;
  default_margin?: string;
  /** Dollars, as typed: "2.99". */
  price?: string;
}

/**
 * Apply case costs, margin and price to every flavor of a product at once.
 * Only what was filled in is sent, so a flavor keeps its own value for
 * anything left blank. One request, one transaction on the API: either every
 * flavor changes or none does.
 */
export async function applyToAllFlavorsAction(
  productId: string,
  storeId: string | null,
  fields: AllFlavorsFields,
): Promise<ActionResult<{ updated: number }>> {
  const body: Record<string, unknown> = {};
  const units = fields.case_quantity?.trim();
  if (units) {
    const parsed = Number(units);
    if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, error: "Units per case must be a whole number, like 12." };
    body.case_quantity = parsed;
  }
  for (const key of ["case_cost", "case_discount", "case_rebate", "default_margin"] as const) {
    const value = fields[key]?.trim();
    if (value) body[key] = value;
  }
  const price = fields.price?.trim();
  if (price) {
    const minor = parseMajorToMinor(price);
    if (minor === null) return { ok: false, error: "Enter a valid price, like 2.99" };
    body.price_minor = minor;
    body.store_id = storeId;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: "Nothing to apply. Fill in at least one box." };

  try {
    const data = await apiFetch<{ updated: number }>(`/api/v1/catalog/products/${productId}/variants/apply-all`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data: { updated: data.updated } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not apply that to every flavor." };
  }
}
