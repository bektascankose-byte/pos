"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createShiftAction, cancelShiftAction, createShiftBatchAction } from "./actions";
import type { CreateShift, Shift } from "@snappos/contracts";

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

function localDate(value: string): Date { return new Date(`${value}T00:00:00`); }
function slotTime(slot: number): string { return `${String(Math.floor(slot / 2) % 24).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`; }
function shiftIso(date: string, time: string, nextDay = false): string {
  const day = localDate(date);
  if (nextDay) day.setDate(day.getDate() + 1);
  const [hour, minute] = time.split(":").map(Number);
  day.setHours(hour ?? 0, minute ?? 0, 0, 0);
  return day.toISOString();
}
function repeatDates(start: string, end: string, cadence: "weekly" | "monthly", weekdays: number[], monthDay: number): string[] {
  const first = localDate(start);
  const last = localDate(end);
  const horizon = localDate(start);
  horizon.setFullYear(horizon.getFullYear() + 1);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first > last || last > horizon) return [];
  const dates: string[] = [];
  for (const day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
    if (cadence === "weekly" ? weekdays.includes(day.getDay()) : day.getDate() === monthDay) dates.push(toDateString(day));
    if (dates.length > 120) break;
  }
  return dates;
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
  useEffect(() => setShifts(initialShifts), [initialShifts]);
  const timelineScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (timelineScroll.current) timelineScroll.current.scrollLeft = 8 * 48; }, []);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [addPending, startAddTransition] = useTransition();
  const [cancelPending, startCancelTransition] = useTransition();
  const [repeatPending, startRepeatTransition] = useTransition();

  const activeEmployees = employees.filter((e) => e.status === "active" || e.status === "invited");
  const [selectedEmployee, setSelectedEmployee] = useState(activeEmployees[0]?.id ?? "");
  const [shiftDate, setShiftDate] = useState(weekStartStr);
  const [shiftStart, setShiftStart] = useState("09:00");
  const [shiftEnd, setShiftEnd] = useState("17:00");
  const [selection, setSelection] = useState<{ date: string; start: number; end: number } | null>(null);
  const [drag, setDrag] = useState<{ date: string; start: number } | null>(null);
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  const [repeatEmployee, setRepeatEmployee] = useState(activeEmployees[0]?.id ?? "");
  const [rangeStart, setRangeStart] = useState(weekStartStr);
  const [rangeEnd, setRangeEnd] = useState(() => { const d = localDate(weekStartStr); d.setDate(d.getDate() + 27); return toDateString(d); });
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [monthDay, setMonthDay] = useState(localDate(weekStartStr).getDate());
  const [repeatStart, setRepeatStart] = useState("09:00");
  const [repeatEnd, setRepeatEnd] = useState("17:00");
  const [repeatNote, setRepeatNote] = useState("");
  const occurrences = useMemo(() => repeatDates(rangeStart, rangeEnd, cadence, weekdays, monthDay), [rangeStart, rangeEnd, cadence, weekdays, monthDay]);

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
        setSelection(null);
        const note = form.elements.namedItem("note") as HTMLInputElement | null;
        if (note) note.value = "";
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

  const chooseTime = (date: string, a: number, b: number) => {
    const start = Math.min(a, b);
    const end = Math.min(48, Math.max(a, b) + (a === b ? 2 : 1));
    setSelection({ date, start, end });
    setShiftDate(date);
    setShiftStart(slotTime(start));
    setShiftEnd(slotTime(end));
  };

  const handleRepeat = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!storeId || !repeatEmployee || !occurrences.length || occurrences.length > 120) {
      setMessage({ kind: "error", text: "Choose an employee and a date range with 1–120 shifts within one year." });
      return;
    }
    const batch: CreateShift[] = occurrences.map((date) => ({
      store_id: storeId,
      user_id: repeatEmployee,
      starts_at: shiftIso(date, repeatStart),
      ends_at: shiftIso(date, repeatEnd, repeatEnd <= repeatStart),
      ...(repeatNote.trim() ? { note: repeatNote.trim() } : {}),
    }));
    startRepeatTransition(async () => {
      const result = await createShiftBatchAction(batch);
      if (result.ok) {
        const weekEnd = localDate(days[6]!);
        weekEnd.setDate(weekEnd.getDate() + 1);
        setShifts((current) => [...current, ...result.data.filter((shift) => new Date(shift.starts_at) < weekEnd && new Date(shift.ends_at) > localDate(weekStartStr))]);
        setMessage({ kind: "success", text: `${result.data.length} shifts added. Use Next week to review the rest.` });
      } else setMessage({ kind: "error", text: result.error });
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
        <p role="status" className={`rounded-lg border bg-white p-3 text-sm ${message.kind === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>
          {message.text}
        </p>
      ) : null}

      <section className="insights-panel">
        <div className="insights-panel-head flex-wrap">
          <div><h2 className="insights-panel-title">Visual schedule</h2><p className="insights-panel-subtitle">Choose an employee, then drag across a day to select a shift. Tap a slot for one hour.</p></div>
          <label className="schedule-field">Employee
            <select className="schedule-input" aria-label="Employee for visual schedule" value={selectedEmployee} onChange={(event) => setSelectedEmployee(event.target.value)}>
              {activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}
            </select>
          </label>
        </div>
        {activeEmployees.length === 0 ? <p className="insights-empty">Add an active employee to start scheduling.</p> : (
          <div className="schedule-scroll" ref={timelineScroll}><div className="schedule-board">
            <div className="schedule-row"><div className="schedule-day-label">Day</div><div className="schedule-axis">{Array.from({ length: 13 }, (_, index) => <span key={index} style={{ left: index * 96 }}>{index === 12 ? "12 am" : `${index * 2}:00`}</span>)}</div></div>
            {days.map((date) => {
              const dayStart = localDate(date).getTime();
              const nextDay = localDate(date); nextDay.setDate(nextDay.getDate() + 1);
              const dayEnd = nextDay.getTime();
              const visualShifts = shifts.filter((shift) => shift.user_id === selectedEmployee && new Date(shift.starts_at).getTime() < dayEnd && new Date(shift.ends_at).getTime() > dayStart);
              return <div className="schedule-row" key={date}>
                <div className="schedule-day-label"><strong>{DAY_LABELS[localDate(date).getDay()]}</strong><small>{localDate(date).toLocaleDateString([], { month: "short", day: "numeric" })}</small></div>
                <div className="schedule-track" role="button" tabIndex={0} aria-label={`Select shift time on ${date}`} style={{ width: 1152 }}
                  onPointerDown={(event) => { const slot = Math.min(47, Math.max(0, Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / 24))); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ date, start: slot }); chooseTime(date, slot, slot); }}
                  onPointerMove={(event) => { if (drag?.date === date && event.buttons === 1) chooseTime(date, drag.start, Math.min(47, Math.max(0, Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / 24)))); }}
                  onPointerUp={(event) => { if (drag?.date === date) chooseTime(date, drag.start, Math.min(47, Math.max(0, Math.floor((event.clientX - event.currentTarget.getBoundingClientRect().left) / 24)))); setDrag(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseTime(date, 18, 19); } }}>
                  {visualShifts.map((shift) => { const start = Math.max(dayStart, new Date(shift.starts_at).getTime()); const end = Math.min(dayEnd, new Date(shift.ends_at).getTime()); return <span key={shift.id} className="schedule-block" style={{ left: `${((start - dayStart) / (dayEnd - dayStart)) * 100}%`, width: `${((end - start) / (dayEnd - dayStart)) * 100}%` }} title={`${formatTime(shift.starts_at)}–${formatTime(shift.ends_at)}`}>{formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}</span>; })}
                  {selection?.date === date ? <span className="schedule-selection" style={{ left: selection.start * 24, width: (selection.end - selection.start) * 24 }} /> : null}
                </div>
              </div>;
            })}
          </div></div>
        )}
        <p className="border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-muted)]">Each small interval is 30 minutes. Existing shifts are orange; your selection is the dashed blue box. Scroll sideways to reach later hours.</p>
      </section>

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
        {selection ? <p className="mb-3 text-xs font-medium text-[var(--color-accent)]">Selected {selection.date}, {slotTime(selection.start)}–{slotTime(selection.end)}</p> : null}
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="store_id" value={storeId ?? ""} />
          <label className="flex flex-col gap-1 text-sm">
            Employee
            <select
              name="user_id"
              required
              value={selectedEmployee}
              onChange={(event) => setSelectedEmployee(event.target.value)}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            >
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
              value={shiftDate}
              onChange={(event) => { setShiftDate(event.target.value); setSelection(null); }}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Start
            <input
              type="time"
              name="start_time"
              required
              value={shiftStart}
              onChange={(event) => { setShiftStart(event.target.value); setSelection(null); }}
              className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            End
            <input
              type="time"
              name="end_time"
              required
              value={shiftEnd}
              onChange={(event) => { setShiftEnd(event.target.value); setSelection(null); }}
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
      <section className="insights-panel insights-panel-pad">
        <h2 className="insights-panel-title">Set a repeating schedule</h2>
        <p className="insights-panel-subtitle mb-4">Create a weekly or monthly pattern through a chosen end date in one setup. All shifts save together.</p>
        <form onSubmit={handleRepeat} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="schedule-field sm:col-span-2">Employee<select className="schedule-input" value={repeatEmployee} onChange={(event) => setRepeatEmployee(event.target.value)} required>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>
          <label className="schedule-field sm:col-span-2">Repeat<select className="schedule-input" value={cadence} onChange={(event) => setCadence(event.target.value as "weekly" | "monthly")}><option value="weekly">Every week</option><option value="monthly">Every month</option></select></label>
          {cadence === "weekly" ? <fieldset className="sm:col-span-2 lg:col-span-4"><legend className="schedule-field mb-2">Days of the week</legend><div className="flex flex-wrap gap-2">{DAY_LABELS.map((label, index) => <label key={label} className={`schedule-day-chip ${weekdays.includes(index) ? "selected" : ""}`}><input type="checkbox" className="sr-only" checked={weekdays.includes(index)} onChange={() => setWeekdays((current) => current.includes(index) ? current.filter((day) => day !== index) : [...current, index])} />{label}</label>)}</div></fieldset> : <label className="schedule-field sm:col-span-2 lg:col-span-4">Day of month<select className="schedule-input max-w-[180px]" value={monthDay} onChange={(event) => setMonthDay(Number(event.target.value))}>{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select><small className="font-normal text-[var(--color-text-muted)]">Months without this date are skipped.</small></label>}
          <label className="schedule-field">From<input className="schedule-input" type="date" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} required /></label>
          <label className="schedule-field">Through<input className="schedule-input" type="date" min={rangeStart} value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} required /></label>
          <label className="schedule-field">Start<input className="schedule-input" type="time" value={repeatStart} onChange={(event) => setRepeatStart(event.target.value)} required /></label>
          <label className="schedule-field">End<input className="schedule-input" type="time" value={repeatEnd} onChange={(event) => setRepeatEnd(event.target.value)} required /></label>
          <label className="schedule-field sm:col-span-2 lg:col-span-3">Note<input className="schedule-input" maxLength={500} value={repeatNote} onChange={(event) => setRepeatNote(event.target.value)} placeholder="Optional" /></label>
          <div className="flex items-end"><button type="submit" disabled={repeatPending || occurrences.length < 1 || occurrences.length > 120 || !storeId} className="insights-button primary w-full disabled:opacity-50">{repeatPending ? "Setting…" : "Set schedule"}</button></div>
          <p className="sm:col-span-2 lg:col-span-4 rounded-md border border-[var(--color-accent-ring)] bg-[var(--color-accent-soft)] p-3 text-xs font-semibold text-[var(--color-accent)]">{occurrences.length > 120 ? "More than 120 shifts. Shorten the date range." : `${occurrences.length} shifts will be created.`} Date range can span up to one year. If the end time is earlier, the shift ends the next day.</p>
        </form>
      </section>
    </div>
  );
}
