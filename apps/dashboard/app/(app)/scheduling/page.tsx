import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import { createShiftAction, cancelShiftAction } from "./actions";
import type { Shift } from "@snappos/contracts";

interface EmployeeRow {
  id: string;
  full_name: string;
  status: string;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(weekStart?: string): Date {
  const base = weekStart ? new Date(`${weekStart}T00:00:00`) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default async function SchedulingPage({
  searchParams,
}: {
  searchParams: Promise<{ weekStart?: string; saved?: string; error?: string }>;
}) {
  const { weekStart: weekStartParam, saved, error } = await searchParams;
  const weekStart = startOfWeek(weekStartParam);
  const weekStartStr = toDateString(weekStart);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const prevWeek = new Date(weekStart);
  prevWeek.setDate(prevWeek.getDate() - 7);
  const nextWeek = new Date(weekStart);
  nextWeek.setDate(nextWeek.getDate() + 7);

  let employees: EmployeeRow[] = [];
  let shifts: Shift[] = [];
  let storeId: string | null = null;
  let loadError: string | null = null;

  try {
    storeId = await primaryStoreId();
    const qs = `from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}${storeId ? `&store_id=${storeId}` : ""}`;
    [employees, shifts] = await Promise.all([
      apiFetch<EmployeeRow[]>(`/api/v1/employees`),
      apiFetch<Shift[]>(`/api/v1/scheduling/shifts?${qs}`),
    ]);
  } catch (e) {
    loadError = e instanceof ApiError ? e.message : "Could not load the schedule.";
  }

  employees = employees.filter((e) => e.status === "active" || e.status === "invited");

  const shiftsByEmployeeAndDay = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const dayIndex = new Date(shift.starts_at).getDay();
    const key = `${shift.user_id}:${dayIndex}`;
    const existing = shiftsByEmployeeAndDay.get(key) ?? [];
    existing.push(shift);
    shiftsByEmployeeAndDay.set(key, existing);
  }

  const createShift = createShiftAction.bind(null, weekStartStr);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Scheduling</h1>
        <div className="flex gap-2 text-sm">
          <a
            href={`/scheduling?weekStart=${toDateString(prevWeek)}`}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg)]"
          >
            ← Previous week
          </a>
          <a
            href={`/scheduling?weekStart=${toDateString(nextWeek)}`}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg)]"
          >
            Next week →
          </a>
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Week of {weekStart.toLocaleDateString()} – {days[6]!.toLocaleDateString()}
      </p>

      {saved ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 font-normal">Employee</th>
              {days.map((d, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 font-normal">
                  {DAY_LABELS[i]} {d.getMonth() + 1}/{d.getDate()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => (
              <tr key={employee.id} className="border-t border-[var(--color-border)] align-top">
                <td className="whitespace-nowrap px-3 py-2 font-medium">{employee.full_name}</td>
                {days.map((_, dayIndex) => {
                  const cellShifts = shiftsByEmployeeAndDay.get(`${employee.id}:${dayIndex}`) ?? [];
                  return (
                    <td key={dayIndex} className="px-3 py-2">
                      {cellShifts.length === 0 ? (
                        <span className="text-[var(--color-text-muted)]">—</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {cellShifts.map((shift) => {
                            const cancelShift = cancelShiftAction.bind(null, weekStartStr, shift.id);
                            return (
                              <div key={shift.id} className="flex items-center gap-2 whitespace-nowrap">
                                <span>
                                  {formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}
                                </span>
                                <form action={cancelShift}>
                                  <button type="submit" className="text-xs text-[var(--color-error)]">
                                    Cancel
                                  </button>
                                </form>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {employees.length === 0 && !loadError ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--color-text-muted)]">
                  No employees yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-muted)]">Add a shift</h2>
        <form action={createShift} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="store_id" value={storeId ?? ""} />
          <label className="flex flex-col gap-1 text-sm">
            Employee
            <select
              name="user_id"
              required
              defaultValue=""
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
              <option value="" disabled>
                Choose
              </option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Date
            <input
              type="date"
              name="date"
              required
              min={toDateString(weekStart)}
              max={toDateString(days[6]!)}
              defaultValue={toDateString(weekStart)}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Start
            <input
              type="time"
              name="start_time"
              required
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            End
            <input
              type="time"
              name="end_time"
              required
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Note
            <input
              name="note"
              placeholder="optional"
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          >
            Add shift
          </button>
        </form>
      </section>
    </div>
  );
}
