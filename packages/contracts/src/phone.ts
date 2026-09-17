/**
 * US phone numbers, however a person types them.
 *
 * The register finds a loyalty member by exact phone match, and customers are
 * stored in E.164 (`+12545550123`) so that match works. A customer on the
 * website types "(254) 555-0123", "254.555.0123" or "1 254 555 0123"; all of
 * those are the same number and have to find the same record, or linking an
 * account to in-store rewards fails for no reason the customer could see.
 *
 * North American numbers only. The shop is in Texas and its loyalty members
 * are local; a number that is not a valid NANP number is refused rather than
 * guessed into shape.
 */

/** E.164 for a valid US or Canadian number, or null. */
export function normalizeUsPhone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Anything besides digits, spaces and the usual punctuation is not a phone number.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  else if (trimmed.startsWith('+')) return null;
  if (digits.length !== 10) return null;

  // Area codes and exchanges never start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

/** "(254) 555-0123" for a US E.164 number; the input unchanged for anything else. */
export function formatUsPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

/** The last four digits only, for telling someone which phone a code went to. */
export function phoneHint(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return `ending in ${digits.slice(-4)}`;
}
