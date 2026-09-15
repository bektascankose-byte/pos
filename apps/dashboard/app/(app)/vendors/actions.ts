"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import { normalizePhone } from "@/lib/phone";
import { parseMajorToMinor } from "@/lib/money";
import type { Vendor } from "@snappos/contracts";

/** Plain text fields, trimmed; an empty one is omitted rather than sent as "". */
const TEXT_FIELDS = [
  "code",
  "name",
  "contact_name",
  "sales_rep_name",
  "website",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
  "payment_terms",
  "notes",
] as const;

const PHONE_FIELDS = ["phone", "sales_rep_phone"] as const;
const EMAIL_FIELDS = ["email", "sales_rep_email"] as const;

/**
 * Dollars in the box, minor units on the wire -- a vendor minimum is typed as
 * "250" or "$1,000.00", never as 25000. The currency dressing is stripped
 * here; the digits go through the same `parseMajorToMinor` every other price
 * field in the back office uses, so nothing is parsed as a float.
 */
function dollarsToMinor(input: string): string | null {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (!trimmed) return null;
  return parseMajorToMinor(trimmed);
}

/**
 * Shared by create and update: the fields a person types, read off the form.
 * Only fields with something in them are sent -- on update an empty field
 * means "leave this alone", matching the API's own `COALESCE` per column.
 */
function readVendorFields(formData: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  for (const field of TEXT_FIELDS) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = field === "country" ? value.toUpperCase() : value;
  }
  for (const field of PHONE_FIELDS) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = normalizePhone(value);
  }
  for (const field of EMAIL_FIELDS) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }

  const leadTime = String(formData.get("lead_time_days") ?? "").trim();
  if (leadTime) body.lead_time_days = Number(leadTime);

  for (const field of ["minimum_order_minor", "free_shipping_threshold_minor"] as const) {
    const minor = dollarsToMinor(String(formData.get(field) ?? ""));
    if (minor !== null) body[field] = minor;
  }

  return body;
}

export async function createVendorAction(formData: FormData): Promise<ActionResult<Vendor>> {
  const body = readVendorFields(formData);
  if (!body.code || !body.name) {
    return { ok: false, error: "A vendor needs a code and a name." };
  }

  try {
    const data = await apiFetch<Vendor>(`/api/v1/purchasing/vendors`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that vendor." };
  }
}

export async function updateVendorAction(id: string, formData: FormData): Promise<ActionResult<Vendor>> {
  try {
    const data = await apiFetch<Vendor>(`/api/v1/purchasing/vendors/${id}`, {
      method: "PATCH",
      body: JSON.stringify(readVendorFields(formData)),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save changes." };
  }
}

/**
 * Archive rather than delete. Purchase orders, receipts, invoice imports and
 * the vendor's own SKU mappings all point at this row; removing it would
 * either break that history or take it along. An archived vendor stops
 * appearing in the vendor list and can no longer be picked for a new purchase
 * order or invoice -- and can be restored.
 */
export async function setVendorStatusAction(
  id: string,
  status: "active" | "archived",
): Promise<ActionResult<Vendor>> {
  try {
    const data = await apiFetch<Vendor>(`/api/v1/purchasing/vendors/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not change that vendor's status.",
    };
  }
}
