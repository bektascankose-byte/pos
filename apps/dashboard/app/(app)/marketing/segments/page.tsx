import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/api";
import type { Segment } from "@snappos/contracts";

/** A definition back into the sentence a person wrote it as. */
function describe(definition: Segment["definition"]): string {
  const parts: string[] = [];
  if (definition.bought_product_id || definition.bought_category_id) {
    parts.push(
      definition.within_days ? `bought in the last ${definition.within_days} days` : "has bought this before",
    );
  }
  if (definition.not_seen_days) parts.push(`nothing bought for ${definition.not_seen_days} days`);
  if (definition.min_visits) parts.push(`${definition.min_visits}+ visits`);
  if (definition.min_lifetime_spend_minor !== undefined) {
    parts.push(`spent $${BigInt(definition.min_lifetime_spend_minor) / 100n}+`);
  }
  if (definition.has_tag) parts.push(`tagged "${definition.has_tag}"`);
  return parts.length > 0 ? parts.join(" · ") : "every active customer";
}

export default async function SegmentsPage() {
  let segments: Segment[] = [];
  let error: string | null = null;
  try {
    segments = await apiFetch<Segment[]>(`/api/v1/marketing/segments`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Could not load segments.";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Segments</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            A saved question about your customers — who buys what, who&apos;s drifted away, who spends.
          </p>
        </div>
        <Link
          href="/marketing/segments/new"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
        >
          New segment
        </Link>
      </div>

      {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-4 py-2 font-normal">Name</th>
              <th className="px-4 py-2 font-normal">Who&apos;s in it</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <Link href={`/marketing/segments/${segment.id}`} className="text-[var(--color-accent)]">
                    {segment.name}
                  </Link>
                  {segment.description ? (
                    <div className="text-xs text-[var(--color-text-muted)]">{segment.description}</div>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-[var(--color-text-muted)]">{describe(segment.definition)}</td>
              </tr>
            ))}
            {segments.length === 0 && !error ? (
              <tr>
                <td colSpan={2} className="px-4 py-6 text-center text-[var(--color-text-muted)]">
                  No segments yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
