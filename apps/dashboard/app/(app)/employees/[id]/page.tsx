import { notFound } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import type { Employee, Role, OnboardingChecklist } from "@snappos/contracts";
import {
  updateEmployeeAction,
  setPinAction,
  assignRoleAction,
  removeRoleAction,
  completeChecklistItemAction,
  reopenChecklistItemAction,
  addChecklistItemAction,
} from "../actions";

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, error } = await searchParams;

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

  const updateEmployee = updateEmployeeAction.bind(null, id);
  const setPin = setPinAction.bind(null, id);
  const assignRole = assignRoleAction.bind(null, id);
  const addChecklistItem = addChecklistItemAction.bind(null, id);
  const completedCount = checklist?.items.filter((i) => i.is_completed).length ?? 0;

  const heldRoleKeys = new Set((employee.roles ?? []).map((r) => r.role_key));
  const availableRoles = roles.filter((r) => !heldRoleKeys.has(r.key));

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">{employee.full_name}</h1>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Details</h2>
        <form action={updateEmployee} className="flex flex-col gap-4">
          <p className="text-xs text-[var(--color-text-muted)]">
            Leave a field blank to keep its current value.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Full name" name="full_name" defaultValue={employee.full_name} />
            <Field label="Display name (receipts)" name="display_name" defaultValue={employee.display_name ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Email" name="email" defaultValue={employee.email ?? ""} />
            <Field label="Phone" name="phone" defaultValue={employee.phone ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Employee code" name="employee_code" defaultValue={employee.employee_code ?? ""} />
            <Select
              label="Status"
              name="status"
              current={employee.status}
              options={[
                { id: "invited", name: "Invited" },
                { id: "active", name: "Active" },
                { id: "suspended", name: "Suspended" },
                { id: "terminated", name: "Terminated" },
              ]}
            />
          </div>
          <button
            type="submit"
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Save
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Roles</h2>
        <ul className="mb-4 flex flex-col gap-2">
          {(employee.roles ?? []).map((role) => {
            const removeRole = removeRoleAction.bind(null, id, role.id);
            return (
              <li key={role.id} className="flex items-center justify-between text-sm">
                <span>{role.role_name}</span>
                <form action={removeRole}>
                  <button type="submit" className="text-[var(--color-error)]">
                    Remove
                  </button>
                </form>
              </li>
            );
          })}
          {(employee.roles ?? []).length === 0 ? (
            <li className="text-sm text-[var(--color-text-muted)]">No roles assigned.</li>
          ) : null}
        </ul>
        {availableRoles.length > 0 ? (
          <form action={assignRole} className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Add role
              <select
                name="role_key"
                defaultValue=""
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              >
                <option value="" disabled>
                  Choose a role
                </option>
                {availableRoles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
            >
              Add
            </button>
          </form>
        ) : null}
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Reset PIN</h2>
        <form action={setPin} className="flex items-end gap-2">
          <Field label="New PIN (4-8 digits)" name="pin" />
          <button
            type="submit"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          >
            Reset
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--color-text-muted)]">Onboarding</h2>
          {checklist ? (
            <span className="text-xs text-[var(--color-text-muted)]">
              {checklist.completed_at ? (
                <span className="text-[var(--color-success)]">All done</span>
              ) : (
                `${completedCount} of ${checklist.items.length} complete`
              )}
            </span>
          ) : null}
        </div>

        {checklist ? (
          <>
            <ul className="mb-4 flex flex-col gap-2">
              {checklist.items.map((item) => {
                const complete = completeChecklistItemAction.bind(null, id, item.id);
                const reopen = reopenChecklistItemAction.bind(null, id, item.id);
                return (
                  <li key={item.id} className="flex items-start justify-between gap-2 text-sm">
                    <div>
                      <span className={item.is_completed ? "line-through text-[var(--color-text-muted)]" : ""}>
                        {item.title}
                      </span>
                      {item.is_completed ? (
                        <span className="block text-xs text-[var(--color-text-muted)]">
                          {item.completed_by_name ? `${item.completed_by_name} · ` : ""}
                          {item.completed_at ? new Date(item.completed_at).toLocaleDateString() : ""}
                        </span>
                      ) : null}
                    </div>
                    <form action={item.is_completed ? reopen : complete}>
                      <button
                        type="submit"
                        className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs"
                      >
                        {item.is_completed ? "Reopen" : "Check off"}
                      </button>
                    </form>
                  </li>
                );
              })}
              {checklist.items.length === 0 ? (
                <li className="text-sm text-[var(--color-text-muted)]">No tasks on this checklist.</li>
              ) : null}
            </ul>
            <form action={addChecklistItem} className="flex items-end gap-2">
              <Field label="Add a one-off task" name="title" />
              <button
                type="submit"
                className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
              >
                Add
              </button>
            </form>
          </>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            No onboarding checklist -- this employee was hired before onboarding checklists existed.
          </p>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

function Select({
  label,
  name,
  current,
  options,
}: {
  label: string;
  name: string;
  current: string;
  options: { id: string; name: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select
        name={name}
        defaultValue={current}
        className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
