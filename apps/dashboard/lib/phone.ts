/**
 * The contract stores phones as E.164 ("+15125550123") so a lookup by phone
 * actually matches, but nobody types a US number that way. A plain 10-digit
 * number, or 11 starting with 1, is turned into E.164 here; anything else is
 * passed through untouched for the API to accept or reject on its own terms,
 * since guessing a country code for an unrecognizable number would be worse
 * than saying so.
 *
 * Shared rather than per-form: customers, vendors and vendor sales reps all
 * have a phone field, and a number that normalizes on one form and is
 * rejected on the next is worse than one that behaves the same everywhere.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  // An already-international number still has to lose its spacing: "+1 346
  // 218 4817" is how a letterhead prints one (and how AI vendor extraction
  // reads it back), and E.164 has no room for the spaces, dashes or
  // parentheses. Only the punctuation goes -- the country code is the
  // caller's, not something to re-guess.
  if (trimmed.startsWith("+")) return digits ? `+${digits}` : trimmed;

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}
