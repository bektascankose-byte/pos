"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Customer } from "@snappos/contracts";

/**
 * Only fields the admin actually typed something into are sent -- an empty
 * field means "leave this alone", not "clear it" (the API's update endpoint
 * has no way to clear a field yet either; see `CustomersService.update`).
 * The form says so, so a blanked-out box that reappears filled after saving
 * doesn't read as a bug.
 */
export async function updateCustomerAction(id: string, formData: FormData): Promise<void> {
  const body: Record<string, string> = {};
  for (const field of ["first_name", "last_name", "phone", "email", "notes"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }

  try {
    await apiFetch<Customer>(`/api/v1/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save changes.";
    redirect(`/customers/${id}?error=${encodeURIComponent(message)}`);
  }

  redirect(`/customers/${id}?saved=1`);
}
