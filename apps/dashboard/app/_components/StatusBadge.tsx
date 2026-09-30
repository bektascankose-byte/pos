/*
 * A status as a coloured pill, so a list of orders or invoices can be read by
 * colour before it is read by word: green is done, amber is waiting on
 * someone, red went wrong or was undone, blue is new.
 *
 * The API owns the vocabulary and adds to it over time, so anything this does
 * not recognise still renders, just in the neutral grey.
 */

type Tone = "ok" | "wait" | "bad" | "new" | "neutral";

const TONES: Record<Tone, string[]> = {
  ok: ["completed", "committed", "received", "reviewed", "active", "sent", "paid", "fulfilled", "delivered", "picked_up", "done", "closed", "verified", "matched"],
  wait: ["pending", "parsed", "draft", "open", "partial", "partially_received", "scheduled", "processing", "preparing", "ready", "ready_for_pickup", "submitted", "ordered", "in_progress", "awaiting", "uploaded", "queued", "sending"],
  bad: ["voided", "void", "cancelled", "canceled", "failed", "terminated", "error", "rejected", "refunded", "expired", "archived"],
  new: ["new", "placed", "confirmed", "accepted"],
  neutral: [],
};

function toneFor(status: string): Tone {
  const key = status.trim().toLowerCase().replaceAll(" ", "_");
  for (const tone of Object.keys(TONES) as Tone[]) {
    if (TONES[tone].includes(key)) return tone;
  }
  return "neutral";
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`bo-status ${toneFor(status)}`}>{label ?? status.replaceAll("_", " ")}</span>;
}
