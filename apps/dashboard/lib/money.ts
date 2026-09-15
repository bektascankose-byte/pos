/** Minor units, as a digit string off the wire -- see `packages/contracts/src/money.ts`. Never parsed as a float. */
export function formatMinor(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

/**
 * Minor units to the bare dollar amount a form field holds ("2499" ->
 * "24.99"). `formatMinor`'s counterpart for editing rather than display: an
 * input pre-filled with "$24.99" fails validation the moment it is saved
 * unchanged.
 */
export function minorToMajor(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * A dollar amount typed into a form ("24.99") to minor units ("2499"), the
 * shape `moneyMinor` in `packages/contracts/src/primitives.ts` accepts. Never
 * via a float: parsed digit by digit the same way the register's own
 * `Money.fromMajor` does.
 */
export function parseMajorToMinor(input: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const [, sign, whole, frac = ""] = match;
  const cents = `${whole}${frac.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
  return `${sign}${cents}`;
}
