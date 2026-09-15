"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import { normalizePhone } from "@/lib/phone";
import type { Customer } from "@snappos/contracts";

/** Shared by create and update: the fields a person types, read off the form. */
function readCustomerFields(formData: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of ["first_name", "last_name", "phone", "email", "notes"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = field === "phone" ? normalizePhone(value) : value;
  }
  for (const field of ["birth_month", "birth_day"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = Number(value);
  }
  const tags = String(formData.get("tags") ?? "").trim();
  if (tags) {
    body.tags = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return body;
}

/**
 * Only fields the admin actually typed something into are sent -- an empty
 * field means "leave this alone", not "clear it" (the API's update endpoint
 * has no way to clear a field yet either; see `CustomersService.update`).
 * The form says so, so a blanked-out box that reappears filled after saving
 * doesn't read as a bug.
 */
export async function updateCustomerAction(id: string, formData: FormData): Promise<ActionResult<Customer>> {
  try {
    const data = await apiFetch<Customer>(`/api/v1/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(readCustomerFields(formData)),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save changes." };
  }
}

export async function createCustomerAction(formData: FormData): Promise<ActionResult<Customer>> {
  const body = readCustomerFields(formData);
  // The same rule the database and the contract both enforce, checked here so
  // it reads as a sentence instead of a 400 from two layers down.
  if (!body.phone && !body.email) {
    return { ok: false, error: "A customer needs a phone number or an email." };
  }

  try {
    const data = await apiFetch<Customer>(`/api/v1/customers`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that customer." };
  }
}

/**
 * Archive rather than delete. Sales, refunds and loyalty history all point at
 * a customer; removing the row would either break that history or take it
 * along. An archived customer stops appearing in search -- including at the
 * register -- and can be restored.
 */
export async function setCustomerStatusAction(
  id: string,
  status: "active" | "archived",
): Promise<ActionResult<Customer>> {
  try {
    const data = await apiFetch<Customer>(`/api/v1/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : "Could not change that customer's status.",
    };
  }
}
