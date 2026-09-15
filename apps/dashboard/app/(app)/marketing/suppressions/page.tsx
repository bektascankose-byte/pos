import { apiFetch, ApiError } from "@/lib/api";
import type { Suppression } from "@snappos/contracts";

const REASONS: Record<string, string> = {
  unsubscribe: "Unsubscribed",
  bounce: "Bounced",
  complaint: "Reported as spam",
  manual: "Added by hand",
};

/**
 * Addresses that will never be mailed again.
 *
 * Deliberately read-only. Removing an address from this list would mean
 * mailing someone who unsubscribed or whose address hard-bounced, and neither
 * is a decision that should be one click away in a back office — the way back
 * onto the list is the customer opting in again, which is recorded on their
 * own page.
 */
export default async function SuppressionsPage() {
  let suppressions: Suppression[] = [];
  let error: string | null = null;
  try {
    suppressions = await apiFetch<Suppression[]>(`/api/v1/marketing/suppressions`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load the suppression list.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Do not contact</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Addresses that campaigns skip, whatever any opt-in says. Someone gets back on the list by
          opting in again on their own customer page — not from here.
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Address</th>
              <th className="px-4 py-2 font-normal">Channel</th>
              <th className="px-4 py-2 font-normal">Why</th>
              <th className="px-4 py-2 font-normal">Since</th>
            </tr>
          </thead>
          <tbody>
            {suppressions.map((suppression) => (
              <tr key={suppression.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">{suppression.address}</td>
                <td className="px-4 py-2">{suppression.channel}</td>
                <td className="px-4 py-2">{REASONS[suppression.reason] ?? suppression.reason}</td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">
                  {new Date(suppression.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {suppressions.length === 0 && !error ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  Nobody has unsubscribed or bounced.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
