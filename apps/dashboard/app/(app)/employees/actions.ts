"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { Employee, RoleAssignment, OnboardingTaskTemplate } from "@snappos/contracts";

export async function updateEmployeeAction(id: string, formData: FormData): Promise<ActionResult<Employee>> {
  const body: Record<string, unknown> = {};
  for (const field of ["full_name", "display_name", "email", "phone", "employee_code", "hired_at"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }
  const status = String(formData.get("status") ?? "").trim();
  if (status) body.status = status;

  try {
    const data = await apiFetch<Employee>(`/api/v1/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save changes." };
  }
}

export async function setPinAction(id: string, formData: FormData): Promise<ActionResult> {
  const pin = String(formData.get("pin") ?? "").trim();
  try {
    await apiFetch(`/api/v1/employees/${id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not reset the PIN." };
  }
}

export async function assignRoleAction(id: string, formData: FormData): Promise<ActionResult<RoleAssignment>> {
  const roleKey = String(formData.get("role_key") ?? "").trim();
  if (!roleKey) {
    return { ok: false, error: "Choose a role to add." };
  }
  try {
    const data = await apiFetch<RoleAssignment>(`/api/v1/employees/${id}/roles`, {
      method: "POST",
      body: JSON.stringify({ role_key: roleKey }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that role." };
  }
}

export async function removeRoleAction(id: string, userRoleId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/employees/${id}/roles/${userRoleId}`, { method: "DELETE" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not remove that role." };
  }
}

export async function createEmployeeAction(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const roleKey = String(formData.get("role_key") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const pin = String(formData.get("pin") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();

  if (!fullName || !roleKey) {
    return { ok: false, error: "Name and role are required." };
  }
  if (!email && !phone) {
    return { ok: false, error: "An employee needs a phone or an email." };
  }

  const body = {
    full_name: fullName,
    role_key: roleKey,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(pin ? { pin } : {}),
    ...(password ? { password } : {}),
  };

  try {
    const data = await apiFetch<{ id: string }>(`/api/v1/employees`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not create the employee." };
  }
}

export async function createTemplateItemAction(formData: FormData): Promise<ActionResult<OnboardingTaskTemplate>> {
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!title) {
    return { ok: false, error: "Give the task a title." };
  }

  try {
    const data = await apiFetch<OnboardingTaskTemplate>(`/api/v1/onboarding/templates`, {
      method: "POST",
      body: JSON.stringify({ title, ...(description ? { description } : {}) }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that task." };
  }
}

export async function updateTemplateItemAction(
  id: string,
  formData: FormData,
): Promise<ActionResult<OnboardingTaskTemplate>> {
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const isActive = formData.get("is_active") === "on";

  try {
    const data = await apiFetch<OnboardingTaskTemplate>(`/api/v1/onboarding/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(title ? { title } : {}),
        description,
        is_active: isActive,
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save that task." };
  }
}

export async function completeChecklistItemAction(employeeId: string, itemId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items/${itemId}/complete`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not check off that task." };
  }
}

export async function reopenChecklistItemAction(employeeId: string, itemId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items/${itemId}/reopen`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not reopen that task." };
  }
}

export async function addChecklistItemAction(employeeId: string, formData: FormData): Promise<ActionResult> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    return { ok: false, error: "Give the task a title." };
  }

  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that task." };
  }
}
