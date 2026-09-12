"use server";

import { redirect } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";

function toIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

export async function createShiftAction(weekStart: string, formData: FormData): Promise<void> {
  const storeId = String(formData.get("store_id") ?? "").trim();
  const userId = String(formData.get("user_id") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  const startTime = String(formData.get("start_time") ?? "").trim();
  const endTime = String(formData.get("end_time") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  const backTo = `/scheduling?weekStart=${weekStart}`;

  if (!storeId || !userId || !date || !startTime || !endTime) {
    redirect(`${backTo}&error=${encodeURIComponent("An employee, a date, and a start and end time are required.")}`);
  }

  try {
    await apiFetch(`/api/v1/scheduling/shifts`, {
      method: "POST",
      body: JSON.stringify({
        store_id: storeId,
        user_id: userId,
        starts_at: toIso(date, startTime),
        ends_at: toIso(date, endTime),
        ...(note ? { note } : {}),
      }),
    });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not add that shift.";
    redirect(`${backTo}&error=${encodeURIComponent(message)}`);
  }
  redirect(`${backTo}&saved=1`);
}

export async function cancelShiftAction(weekStart: string, shiftId: string): Promise<void> {
  const backTo = `/scheduling?weekStart=${weekStart}`;
  try {
    await apiFetch(`/api/v1/scheduling/shifts/${shiftId}/cancel`, { method: "POST" });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : "Could not cancel that shift.";
    redirect(`${backTo}&error=${encodeURIComponent(message)}`);
  }
  redirect(`${backTo}&saved=1`);
}
