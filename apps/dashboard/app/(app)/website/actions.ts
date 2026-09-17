"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { ComplianceRuleView, CreateComplianceRule, CreatedStorefrontClient } from "@snappos/contracts";

export async function createShopKeyAction(
  storeId: string,
  name: string,
): Promise<ActionResult<CreatedStorefrontClient>> {
  if (!name.trim()) return { ok: false, error: "Name the key after where it will be used." };
  try {
    const data = await apiFetch<CreatedStorefrontClient>(`/api/v1/storefront/clients`, {
      method: "POST",
      body: JSON.stringify({ store_id: storeId, name: name.trim() }),
    });
    revalidatePath("/website");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create a key." };
  }
}

export async function revokeShopKeyAction(id: string): Promise<ActionResult<null>> {
  try {
    await apiFetch(`/api/v1/storefront/clients/${id}/revoke`, { method: "POST" });
    revalidatePath("/website");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not revoke that key." };
  }
}

export async function createRuleAction(input: CreateComplianceRule): Promise<ActionResult<ComplianceRuleView>> {
  try {
    const data = await apiFetch<ComplianceRuleView>(`/api/v1/compliance/rules`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    revalidatePath("/website");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that rule." };
  }
}

export async function endRuleAction(id: string, reason: string): Promise<ActionResult<null>> {
  if (reason.trim().length < 3) return { ok: false, error: "Say why the rule is ending." };
  try {
    await apiFetch(`/api/v1/compliance/rules/${id}/end`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim() }),
    });
    revalidatePath("/website");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not end that rule." };
  }
}
