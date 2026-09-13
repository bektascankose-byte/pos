"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Employee } from "@snappos/contracts";

export async function updateEmployeeAction(id: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const field of ["full_name", "display_name", "email", "phone", "employee_code", "hired_at"] as const) {
    const value = String(formData.get(field) ?? "").trim();
    if (value) body[field] = value;
  }
  const status = String(formData.get("status") ?? "").trim();
  if (status) body.status = status;

  try {
    await apiFetch<Employee>(`/api/v1/employees/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save changes.";
    redirect(`/employees/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${id}?saved=1`);
}

export async function setPinAction(id: string, formData: FormData): Promise<void> {
  const pin = String(formData.get("pin") ?? "").trim();
  try {
    await apiFetch(`/api/v1/employees/${id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not reset the PIN.";
    redirect(`/employees/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${id}?saved=1`);
}

export async function assignRoleAction(id: string, formData: FormData): Promise<void> {
  const roleKey = String(formData.get("role_key") ?? "").trim();
  if (!roleKey) {
    redirect(`/employees/${id}?error=${encodeURIComponent("Choose a role to add.")}`);
  }
  try {
    await apiFetch(`/api/v1/employees/${id}/roles`, {
      method: "POST",
      body: JSON.stringify({ role_key: roleKey }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that role.";
    redirect(`/employees/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${id}?saved=1`);
}

export async function removeRoleAction(id: string, userRoleId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/employees/${id}/roles/${userRoleId}`, { method: "DELETE" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not remove that role.";
    redirect(`/employees/${id}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${id}?saved=1`);
}

export async function createEmployeeAction(formData: FormData): Promise<void> {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const roleKey = String(formData.get("role_key") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const pin = String(formData.get("pin") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();

  if (!fullName || !roleKey) {
    redirect(`/employees/new?error=${encodeURIComponent("Name and role are required.")}`);
  }
  if (!email && !phone) {
    redirect(`/employees/new?error=${encodeURIComponent("An employee needs a phone or an email.")}`);
  }

  const body = {
    full_name: fullName,
    role_key: roleKey,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(pin ? { pin } : {}),
    ...(password ? { password } : {}),
  };

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>(`/api/v1/employees`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not create the employee.";
    redirect(`/employees/new?error=${encodeURIComponent(message)}`);
    return;
  }
  redirect(`/employees/${created.id}?saved=1`);
}

export async function createTemplateItemAction(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!title) {
    redirect(`/employees/onboarding?error=${encodeURIComponent("Give the task a title.")}`);
  }

  try {
    await apiFetch(`/api/v1/onboarding/templates`, {
      method: "POST",
      body: JSON.stringify({ title, ...(description ? { description } : {}) }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that task.";
    redirect(`/employees/onboarding?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/onboarding?saved=1`);
}

export async function updateTemplateItemAction(id: string, formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const isActive = formData.get("is_active") === "on";

  try {
    await apiFetch(`/api/v1/onboarding/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(title ? { title } : {}),
        description,
        is_active: isActive,
      }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not save that task.";
    redirect(`/employees/onboarding?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/onboarding?saved=1`);
}

export async function completeChecklistItemAction(employeeId: string, itemId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items/${itemId}/complete`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not check off that task.";
    redirect(`/employees/${employeeId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${employeeId}?saved=1`);
}

export async function reopenChecklistItemAction(employeeId: string, itemId: string): Promise<void> {
  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items/${itemId}/reopen`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not reopen that task.";
    redirect(`/employees/${employeeId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${employeeId}?saved=1`);
}

export async function addChecklistItemAction(employeeId: string, formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect(`/employees/${employeeId}?error=${encodeURIComponent("Give the task a title.")}`);
  }

  try {
    await apiFetch(`/api/v1/onboarding/checklists/${employeeId}/items`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that task.";
    redirect(`/employees/${employeeId}?error=${encodeURIComponent(message)}`);
  }
  redirect(`/employees/${employeeId}?saved=1`);
}
