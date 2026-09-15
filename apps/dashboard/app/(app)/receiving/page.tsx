import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import { primaryStoreId } from "@/lib/store";
import type { ReceivingSession } from "@snappos/contracts";

export default async function ReceivingPage() {
  let sessions: ReceivingSession[] = [];
  let error: string | null = null;
  try {
    const storeId = await primaryStoreId();
    const qs = storeId ? `?store_id=${storeId}` : "";
    sessions = await apiFetch<ReceivingSession[]>(`/api/v1/receiving${qs}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load deliveries.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Receiving</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Count what turned up, now. The invoice can be matched to it later — or never.
          </p>
        </div>
        <Link
          href="/receiving/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          Receive a delivery
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Reference</th>
              <th className="px-4 py-2 font-normal">Vendor</th>
              <th className="px-4 py-2 text-right font-normal">Lines</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Started</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/receiving/${session.id}`} className="text-[var(--color-accent)]">
                    {session.reference || "(no reference)"}
                  </Link>
                </td>
                <td className="px-4 py-2">{session.vendor_name ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {session.line_count}
                  {session.unresolved_count > 0 ? (
                    <span className="ml-2 text-xs text-[var(--color-error)]">
                      {session.unresolved_count} unknown
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      session.status === "committed"
                        ? "text-[var(--color-success)]"
                        : session.status === "cancelled"
                          ? "text-[var(--color-text-muted)]"
                          : ""
                    }
                  >
                    {session.status === "open"
                      ? "Counting"
                      : session.status === "committed"
                        ? "In stock"
                        : "Cancelled"}
                  </span>
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(session.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {sessions.length === 0 && !error ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  Nothing received yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
