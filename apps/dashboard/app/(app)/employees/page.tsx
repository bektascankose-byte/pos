import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";

interface EmployeeRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  role_names: string[];
}

export default async function EmployeesPage() {
  let rows: EmployeeRow[] = [];
  let error: string | null = null;
  try {
    rows = await apiFetch<EmployeeRow[]>(`/api/v1/employees`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load employees.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Employees</h1>
        <Link
          href="/employees/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Add employee
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Contact</th>
              <th className="px-4 py-2 font-normal">Roles</th>
              <th className="px-4 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/employees/${row.id}`} className="text-[var(--color-accent)]">
                    {row.full_name}
                  </Link>
                </td>
                <td className="px-4 py-2">{row.email ?? row.phone ?? "—"}</td>
                <td className="px-4 py-2">{row.role_names.join(", ") || "—"}</td>
                <td className="px-4 py-2 capitalize">{row.status}</td>
              </tr>
            ))}
            {rows.length === 0 && !error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No employees yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
