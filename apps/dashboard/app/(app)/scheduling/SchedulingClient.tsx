"use client";

import { useMemo, useState, useTransition } from "react";
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SchedulingClient({
  weekStartStr,
  days,
  employees,
  initialShifts,
  storeId,
  prevWeekHref,
  nextWeekHref,
}: {
  weekStartStr: string;
  days: string[]; // ISO date strings, Sun..Sat
  employees: EmployeeRow[];
  initialShifts: Shift[];
  storeId: string | null;
  prevWeekHref: string;
  nextWeekHref: string;
}) {
  const [shifts, setShifts] = useState(initialShifts);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [addPending, startAddTransition] = useTransition();
  const [cancelPending, startCancelTransition] = useTransition();

  const activeEmployees = employees.filter((e) => e.status === "active" || e.status === "invited");

  const shiftsByEmployeeAndDay = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const shift of shifts) {
      const dayIndex = new Date(shift.starts_at).getDay();
      const key = `${shift.user_id}:${dayIndex}`;
      const existing = map.get(key) ?? [];
      existing.push(shift);
      map.set(key, existing);
    }
    return map;
  }, [shifts]);

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);
    const form = e.currentTarget;
    const formData = new FormData(form);
    startAddTransition(async () => {
      const result = await createShiftAction(formData);
      if (result.ok) {
        setShifts((prev) => [...prev, result.data]);
        form.reset();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const handleCancel = (shiftId: string) => {
    setMessage(null);
    startCancelTransition(async () => {
      const result = await cancelShiftAction(shiftId);
      if (result.ok) {
        setShifts((prev) => prev.filter((s) => s.id !== shiftId));
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  };

  const weekStartDate = new Date(`${weekStartStr}T00:00:00`);
  const lastDay = new Date(`${days[6]}T00:00:00`);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Scheduling</h1>
        <div className="flex gap-2 text-sm">
          <a href={prevWeekHref} className="rounded-md border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg)]">
            ← Previous week
          </a>
          <a href={nextWeekHref} className="rounded-md border border-[var(--color-border)] px-3 py-2 hover:bg-[var(--color-bg)]">
            Next week →
          </a>
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Week of {weekStartDate.toLocaleDateString()} – {lastDay.toLocaleDateString()}
      </p>

      {message ? (
        <p className={`text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 font-normal">Employee</th>
              {days.map((d, i) => {
                const date = new Date(`${d}T00:00:00`);
                return (
                  <th key={i} className="whitespace-nowrap px-3 py-2 font-normal">
                    {DAY_LABELS[i]} {date.getMonth() + 1}/{date.getDate()}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {activeEmployees.map((employee) => (
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
                          {cellShifts.map((shift) => (
                            <div key={shift.id} className="flex items-center gap-2 whitespace-nowrap">
                              <span>
                                {formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}
                              </span>
                              <button
                                type="button"
                                disabled={cancelPending}
                                onClick={() => handleCancel(shift.id)}
                                className="text-xs text-[var(--color-error)] disabled:opacity-60"
                              >
                                Cancel
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {activeEmployees.length === 0 ? (
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
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
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
              {activeEmployees.map((e) => (
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
              min={weekStartStr}
              max={toDateString(lastDay)}
              defaultValue={weekStartStr}
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
            disabled={addPending}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] disabled:opacity-60"
          >
            {addPending ? "Adding..." : "Add shift"}
          </button>
        </form>
      </section>
    </div>
  );
}
