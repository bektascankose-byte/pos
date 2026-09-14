import { apiFetch, ApiError } from "@/lib/api";
import type { Role } from "@snappos/contracts";
import { NewEmployeeClient } from "./NewEmployeeClient";

export default async function NewEmployeePage() {
  let roles: Role[] = [];
  let loadError: string | null = null;
  try {
    roles = await apiFetch<Role[]>(`/api/v1/employees/roles`);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load roles.";
  }

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return <NewEmployeeClient roles={roles} />;
}
