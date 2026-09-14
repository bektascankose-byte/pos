import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { Shift } from "@snappos/contracts";
import { SchedulingClient } from "./SchedulingClient";

interface EmployeeRow {
  id: string;
  full_name: string;
  status: string;
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(weekStart?: string): Date {
  const base = weekStart ? new Date(`${weekStart}T00:00:00`) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export default async function SchedulingPage({
  searchParams,
}: {
  searchParams: Promise<{ weekStart?: string }>;
}) {
  const { weekStart: weekStartParam } = await searchParams;
  const weekStart = startOfWeek(weekStartParam);
  const weekStartStr = toDateString(weekStart);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return toDateString(d);
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

  if (loadError) {
    return <p className="text-sm text-[var(--color-error)]">{loadError}</p>;
  }

  return (
    <SchedulingClient
      weekStartStr={weekStartStr}
      days={days}
      employees={employees}
      initialShifts={shifts}
      storeId={storeId}
      prevWeekHref={`/scheduling?weekStart=${toDateString(prevWeek)}`}
      nextWeekHref={`/scheduling?weekStart=${toDateString(nextWeek)}`}
    />
  );
}
