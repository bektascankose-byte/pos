/** Minor units, as a digit string off the wire -- see `packages/contracts/src/money.ts`. Never parsed as a float. */
export function formatMinor(minor: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}
