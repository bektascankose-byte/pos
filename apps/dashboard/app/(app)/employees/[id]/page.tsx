import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Employee, Role, OnboardingChecklist } from "@snappos/contracts";
import { EmployeeDetailClient } from "./EmployeeDetailClient";

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let employee: Employee;
  let roles: Role[] = [];
  try {
    [employee, roles] = await Promise.all([
      apiFetch<Employee>(`/api/v1/employees/${id}`),
      apiFetch<Role[]>(`/api/v1/employees/roles`),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }

  let checklist: OnboardingChecklist | null = null;
  try {
    checklist = await apiFetch<OnboardingChecklist>(`/api/v1/onboarding/checklists/${id}`);
  } catch (e) {
    // Pre-existing employees hired before this feature shipped have none --
    // that's an expected, permanent state for them, not an error.
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }

  return (
    <EmployeeDetailClient employeeId={id} initialEmployee={employee} roles={roles} initialChecklist={checklist} />
  );
}
