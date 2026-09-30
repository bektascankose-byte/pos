import { apiFetch, ApiError } from "@/lib/api";
import type { PosPending } from "@snappos/contracts";
import { SendToPosClient } from "./SendToPosClient";

/**
 * Send to POS.
 *
 * The registers sell from the catalog they were last sent, not the one being
 * edited (migration 0034), so this is where a day's work on the catalog
 * actually reaches the shop floor.
 */
export default async function SendToPosPage() {
  let pending: PosPending | null = null;
  let error: string | null = null;

  try {
    pending = await apiFetch<PosPending>(`/api/v1/catalog/pos-release/pending`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not check what is waiting for the registers.";
  }

  if (error || !pending) {
    return <p className="text-sm text-[var(--color-error)]">{error}</p>;
  }

  return <SendToPosClient initial={pending} />;
}
