"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateEmployeeAction,
  setPinAction,
  assignRoleAction,
  removeRoleAction,
  completeChecklistItemAction,
  reopenChecklistItemAction,
  addChecklistItemAction,
} from "../actions";
import type { Employee, Role, OnboardingChecklist, OnboardingChecklistItem } from "@snappos/contracts";

export function EmployeeDetailClient({
  employeeId,
  initialEmployee,
  roles,
  initialChecklist,
}: {
  employeeId: string;
  initialEmployee: Employee;
  roles: Role[];
  initialChecklist: OnboardingChecklist | null;
}) {
  const router = useRouter();
  const [employee, setEmployee] = useState(initialEmployee);
  const [checklist, setChecklist] = useState(initialChecklist);

  // `useState(initialEmployee)` only seeds from props on first mount --
  // `router.refresh()` (used after assigning a role, since the API doesn't
  // return enough to patch that in locally) re-runs the Server Component
  // and passes a new `initialEmployee`, but without this effect the state
  // variable here would just keep showing the stale one forever.
  useEffect(() => setEmployee(initialEmployee), [initialEmployee]);
  useEffect(() => setChecklist(initialChecklist), [initialChecklist]);
  const [detailsMessage, setDetailsMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [pinMessage, setPinMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);

  const [detailsPending, startDetailsTransition] = useTransition();
  const [rolePending, startRoleTransition] = useTransition();
  const [pinPending, startPinTransition] = useTransition();
  const [taskPending, startTaskTransition] = useTransition();

  const completedCount = checklist?.items.filter((i) => i.is_completed).length ?? 0;
  const heldRoleKeys = new Set((employee.roles ?? []).map((r) => r.role_key));
  const availableRoles = roles.filter((r) => !heldRoleKeys.has(r.key));

  const handleDetailsSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDetailsMessage(null);
    const formData = new FormData(e.currentTarget);
    startDetailsTransition(async () => {
      const result = await updateEmployeeAction(employeeId, formData);
      if (result.ok) {
        setEmployee((prev) => ({ ...result.data, roles: prev.roles }));
        setDetailsMessage({ kind: "success", text: "Saved." });
      } else {
        setDetailsMessage({ kind: "error", text: result.error });
      }
    });
  };

  const handleAssignRole = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRolesError(null);
    const formData = new FormData(e.currentTarget);
    startRoleTransition(async () => {
      const result = await assignRoleAction(employeeId, formData);
      if (result.ok) {
        // The API only confirms the grant, it doesn't return the new
        // assignment's row id or the role's display name -- refetching is
        // what gets both right, rather than rendering a placeholder entry
        // whose own "Remove" button would have nothing real to remove.
        router.refresh();
      } else {
        setRolesError(result.error);
      }
    });
  };

  const handleRemoveRole = (userRoleId: string) => {
    setRolesError(null);
    startRoleTransition(async () => {
      const result = await removeRoleAction(employeeId, userRoleId);
      if (result.ok) {
        setEmployee((prev) => ({ ...prev, roles: (prev.roles ?? []).filter((r) => r.id !== userRoleId) }));
      } else {
        setRolesError(result.error);
      }
    });
  };

  const handleSetPin = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPinMessage(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    startPinTransition(async () => {
      const result = await setPinAction(employeeId, formData);
      if (result.ok) {
        setPinMessage({ kind: "success", text: "PIN reset." });
        form.reset();
      } else {
        setPinMessage({ kind: "error", text: result.error });
      }
    });
  };

  const patchItem = (itemId: string, patch: Partial<OnboardingChecklistItem>) => {
    setChecklist((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i));
      const completed_at = items.every((i) => i.is_completed) ? (prev.completed_at ?? new Date().toISOString()) : null;
      return { ...prev, items, completed_at };
    });
  };

  const handleToggleItem = (item: OnboardingChecklistItem) => {
    setTaskError(null);
    startTaskTransition(async () => {
      const result = item.is_completed
        ? await reopenChecklistItemAction(employeeId, item.id)
        : await completeChecklistItemAction(employeeId, item.id);
      if (result.ok) {
        patchItem(item.id, { is_completed: !item.is_completed });
      } else {
        setTaskError(result.error);
      }
    });
  };

  const handleAddTask = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTaskError(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    const title = String(formData.get("title") ?? "").trim();
    startTaskTransition(async () => {
      const result = await addChecklistItemAction(employeeId, formData);
      if (result.ok) {
        setChecklist((prev) =>
          prev
            ? {
                ...prev,
                completed_at: null,
                items: [
                  ...prev.items,
                  {
                    id: `pending-${Date.now()}`,
                    checklist_id: prev.id,
                    template_item_id: null,
                    title,
                    sort_order: prev.items.length,
                    is_completed: false,
                    completed_by: null,
                    completed_by_name: null,
                    completed_at: null,
                    note: null,
                  },
                ],
              }
            : prev,
        );
        form.reset();
      } else {
        setTaskError(result.error);
      }
    });
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">{employee.full_name}</h1>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Details</h2>
        {detailsMessage ? (
          <p className={`mb-3 text-sm ${detailsMessage.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
            {detailsMessage.text}
          </p>
        ) : null}
        <form onSubmit={handleDetailsSubmit} className="flex flex-col gap-4">
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
            disabled={detailsPending}
            className="self-start rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {detailsPending ? "Saving..." : "Save"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Roles</h2>
        {rolesError ? <p className="mb-2 text-sm text-[var(--color-error)]">{rolesError}</p> : null}
        <ul className="mb-4 flex flex-col gap-2">
          {(employee.roles ?? []).map((role) => (
            <li key={role.id} className="flex items-center justify-between text-sm">
              <span>{role.role_name}</span>
              <button
                type="button"
                disabled={rolePending}
                onClick={() => handleRemoveRole(role.id)}
                className="text-[var(--color-error)] disabled:opacity-60"
              >
                Remove
              </button>
            </li>
          ))}
          {(employee.roles ?? []).length === 0 ? (
            <li className="text-sm text-[var(--color-text-muted)]">No roles assigned.</li>
          ) : null}
        </ul>
        {availableRoles.length > 0 ? (
          <form onSubmit={handleAssignRole} className="flex items-end gap-2">
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
            <button type="submit" disabled={rolePending} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60">
              {rolePending ? "Adding..." : "Add"}
            </button>
          </form>
        ) : null}
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Reset PIN</h2>
        {pinMessage ? (
          <p className={`mb-2 text-sm ${pinMessage.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
            {pinMessage.text}
          </p>
        ) : null}
        <form onSubmit={handleSetPin} className="flex items-end gap-2">
          <Field label="New PIN (4-8 digits)" name="pin" />
          <button type="submit" disabled={pinPending} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60">
            {pinPending ? "Resetting..." : "Reset"}
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

        {taskError ? <p className="mb-2 text-sm text-[var(--color-error)]">{taskError}</p> : null}

        {checklist ? (
          <>
            <ul className="mb-4 flex flex-col gap-2">
              {checklist.items.map((item) => (
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
                  <button
                    type="button"
                    disabled={taskPending}
                    onClick={() => handleToggleItem(item)}
                    className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-60"
                  >
                    {item.is_completed ? "Reopen" : "Check off"}
                  </button>
                </li>
              ))}
              {checklist.items.length === 0 ? (
                <li className="text-sm text-[var(--color-text-muted)]">No tasks on this checklist.</li>
              ) : null}
            </ul>
            <form onSubmit={handleAddTask} className="flex items-end gap-2">
              <Field label="Add a one-off task" name="title" />
              <button type="submit" disabled={taskPending} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60">
                {taskPending ? "Adding..." : "Add"}
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

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue?: string }) {
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
