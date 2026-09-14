"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";
import type { Shift } from "@snappos/contracts";

function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
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
        ends_at: toIso(date, endTime),
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
