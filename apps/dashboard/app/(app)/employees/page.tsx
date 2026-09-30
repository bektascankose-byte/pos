import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { StatusBadge } from "@/app/_components/StatusBadge";
import { getSession } from "@/lib/session";
import { EmployeeRowActions } from "./EmployeeRowActions";

interface EmployeeRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  role_names: string[];
}

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const showFormer = status === "former";
  const session = await getSession();
  let rows: EmployeeRow[] = [];
  let error: string | null = null;
  try {
    rows = await apiFetch<EmployeeRow[]>(`/api/v1/employees`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load employees.";
  }
  const visibleRows = rows.filter((row) => (row.status === "terminated") === showFormer);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Employees</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/employees/onboarding"
            className="whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
          >
            Onboarding checklist template
          </Link>
          <Link
            href="/employees/new"
            className="whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-[var(--color-accent-contrast)]"
          >
            Add employee
          </Link>
        </div>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="flex items-center gap-2 text-sm">
        <Link href="/employees" className={`rounded-md px-3 py-2 ${!showFormer ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]" : "border border-[var(--color-border)]"}`}>Active team</Link>
        <Link href="/employees?status=former" className={`rounded-md px-3 py-2 ${showFormer ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]" : "border border-[var(--color-border)]"}`}>Former employees</Link>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="employee-extra px-4 py-2 font-normal">Contact</th>
              <th className="employee-extra px-4 py-2 font-normal">Roles</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/employees/${row.id}`} className="text-[var(--color-accent)]">
                    {row.full_name}
                  </Link>
                </td>
                <td className="employee-extra px-4 py-2">{row.email ?? row.phone ?? "—"}</td>
                <td className="employee-extra px-4 py-2">{row.role_names.join(", ") || "—"}</td>
                <td className="px-4 py-2"><StatusBadge status={row.status} /></td>
                <td className="px-4 py-2"><EmployeeRowActions id={row.id} name={row.full_name} removed={row.status === "terminated"} canRemove={row.id !== session?.userId} /></td>
              </tr>
            ))}
            {visibleRows.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  {showFormer ? "No former employees." : "No active employees yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
