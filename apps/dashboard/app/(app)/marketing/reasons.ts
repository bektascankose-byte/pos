import type { SegmentPreview } from "@snappos/contracts";

/**
 * Why the matched count and the reachable count differ, as a sentence.
 *
 * Shared by the segment editor and the campaign send screen so the two can't
 * describe the same numbers differently — and so the verb agrees with the
 * count, which reading "1 have no email address" on a live screen made
 * impossible to ignore.
 */
export function unreachableReasons(preview: SegmentPreview): string {
  const parts = [
    // "no opt-in on record" rather than "never opted in": these buckets are
    // mutually exclusive so the numbers add up, which means someone who
    // opted in and later unsubscribed lands here rather than under
    // suppressed. "Never" would be a false statement about that person.
    preview.no_consent > 0
      ? `${preview.no_consent} ${preview.no_consent === 1 ? "has" : "have"} no opt-in on record`
      : null,
    preview.suppressed > 0 ? `${preview.suppressed} unsubscribed or bounced` : null,
    preview.no_address > 0
      ? `${preview.no_address} ${preview.no_address === 1 ? "has" : "have"} no email address`
      : null,
  ].filter(Boolean);
  return parts.join(", ");
}
