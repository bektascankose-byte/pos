"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { Shift, CreateShift } from "@snappos/contracts";

function toIso(date: string, time: string, nextDay = false): string {
  const day = new Date(`${date}T00:00:00`);
  if (nextDay) day.setDate(day.getDate() + 1);
  const [hour, minute] = time.split(":").map(Number);
  day.setHours(hour ?? 0, minute ?? 0, 0, 0);
  return day.toISOString();
}

export async function createShiftAction(formData: FormData): Promise<ActionResult<Shift>> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const userId = String(formData.get("user_id") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  const startTime = String(formData.get("start_time") ?? "").trim();
  const endTime = String(formData.get("end_time") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!storeId || !userId || !date || !startTime || !endTime) {
    return { ok: false, error: "An employee, a date, and a start and end time are required." };
  }

  try {
    const data = await apiFetch<Shift>(`/api/v1/scheduling/shifts`, {
      method: "POST",
      body: JSON.stringify({
        store_id: storeId,
        user_id: userId,
        starts_at: toIso(date, startTime),
        ends_at: toIso(date, endTime, endTime <= startTime),
        ...(note ? { note } : {}),
      }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not add that shift." };
  }
}

export async function cancelShiftAction(shiftId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/api/v1/scheduling/shifts/${shiftId}/cancel`, { method: "POST" });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not cancel that shift." };
  }
}

export async function createShiftBatchAction(shifts: CreateShift[]): Promise<ActionResult<Shift[]>> {
  if (shifts.length < 1 || shifts.length > 120) {
    return { ok: false, error: "Choose between 1 and 120 shifts for this schedule." };
  }
  try {
    const data = await apiFetch<Shift[]>(`/api/v1/scheduling/shifts/batch`, {
      method: "POST",
      body: JSON.stringify({ shifts }),
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not save the repeating schedule." };
  }
}
