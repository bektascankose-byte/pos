/**
 * Money.
 *
 * Two representations, deliberately different, because they answer different
 * questions and conflating them is how retail software quietly loses money.
 *
 *   Posted amounts  - `bigint` minor units (cents). Exact. What a customer was
 *                     actually charged, what a report sums, what a drawer holds.
 *                     Named with a `_minor` suffix everywhere.
 *
 *   Catalog costs   - `numeric(14,6)` fractional. A case of 12 at $5.00 is a
 *                     unit cost of $0.416667. Rounding that to cents corrupts
 *                     margin reporting within weeks, so cost keeps six decimals
 *                     right up until it is posted.
 *
 * Rounding happens exactly once per line, at the moment the line is posted,
 * half up. The rounded value is what is stored. Nothing downstream re-rounds.
 *
 * The rule this file exists to enforce: a money value must never become a
 * JavaScript `number`. IEEE-754 cannot represent 0.1, and a cart that sums
 * floats will disagree with the ledger by a cent often enough to matter and
 * rarely enough to be hard to find. `Money` is a branded bigint with no
 * implicit conversion, so `total + 0.1` is a compile error rather than a
 * support ticket six months later.
 */

/** Branded minor units. Construct with `money()`, never by casting. */
export type Money = bigint & { readonly __brand: 'Money' };

/** Fractional currency, as a decimal string. Costs, not posted amounts. */
export type Decimal = string & { readonly __brand: 'Decimal' };

const MINOR_UNITS_PER_MAJOR = 100n;

/** Postgres bigint range. Anything outside it would not survive a round trip. */
const MAX_MINOR = 9_223_372_036_854_775_807n;
const MIN_MINOR = -9_223_372_036_854_775_808n;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

/** Minor units from a bigint, a whole-number number, or a digit string. */
export function money(value: bigint | number | string): Money {
  let v: bigint;

  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    // A non-integer here means someone passed dollars where cents were wanted,
    // which is a 100x error. Refuse rather than round it away.
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        `money() takes whole minor units, got ${value}. ` +
          `Did you mean fromMajor(${value}) for dollars?`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`${value} is beyond safe integer range; pass a bigint`);
    }
    v = BigInt(value);
  } else {
    if (!/^-?\d+$/.test(value)) {
      throw new MoneyError(`"${value}" is not whole minor units`);
    }
    v = BigInt(value);
  }

  if (v > MAX_MINOR || v < MIN_MINOR) {
    throw new MoneyError(`${v} is outside the range Postgres bigint can store`);
  }
  return v as Money;
}

export const ZERO: Money = money(0n);

/**
 * Parse a major-unit amount: "24.99", "24.9", "24", "-3.50".
 * Rejects more precision than a cent rather than silently discarding it, since
 * "24.999" almost always means a cost was passed where a price was wanted.
 */
export function fromMajor(value: string | number): Money {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new MoneyError(`"${text}" is not a valid amount with at most two decimals`);
  }
  const [, sign, whole, frac = ''] = match;
  const cents = BigInt(whole!) * MINOR_UNITS_PER_MAJOR + BigInt(frac.padEnd(2, '0'));
  return money(sign === '-' ? -cents : cents);
}

/** "2499" -> "24.99". Display only; never parse this back for arithmetic. */
export function toMajorString(value: Money): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MINOR_UNITS_PER_MAJOR;
  const frac = abs % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

export const add = (a: Money, b: Money): Money => money(a + b);
export const subtract = (a: Money, b: Money): Money => money(a - b);
export const negate = (a: Money): Money => money(-a);
export const isZero = (a: Money): boolean => a === 0n;
export const sum = (values: readonly Money[]): Money =>
  values.reduce<Money>((acc, v) => money(acc + v), ZERO);

/** Whole-unit multiply: 3 × $24.99. Exact, no rounding involved. */
export function multiply(amount: Money, quantity: number | bigint): Money {
  const q = typeof quantity === 'bigint' ? quantity : BigInt(quantity);
  if (typeof quantity === 'number' && !Number.isInteger(quantity)) {
    throw new MoneyError(`multiply() takes whole units, got ${quantity}; use applyRate()`);
  }
  return money(amount * q);
}

/**
 * Apply a rate (tax, percentage discount, margin) and round half up.
 *
 * The rate is a decimal string, never a float: 0.0825 is not representable in
 * binary, and tax is the one calculation nobody forgives being a cent off.
 * It is scaled to an integer and the division is done in bigint.
 *
 * Half up, away from zero, matching what the register prints and what the
 * database stores. Banker's rounding is defensible in accounting and wrong
 * here, because a customer comparing two identical receipts would see
 * different totals.
 */
export function applyRate(amount: Money, rate: string): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!match) throw new MoneyError(`"${rate}" is not a valid rate`);

  const [, sign, whole, frac = ''] = match;
  const scale = 10n ** BigInt(frac.length);
  const scaledRate = (BigInt(whole!) * scale + BigInt(frac || '0')) * (sign === '-' ? -1n : 1n);

  const product = amount * scaledRate;
  return money(divideRoundHalfUp(product, scale));
}

/**
 * Split an amount into n parts that sum back to exactly the original.
 *
 * Splitting $10.00 three ways gives 334, 333, 333 and not three times 333 with
 * a cent evaporating. Used by split tender, proportional discount allocation
 * across lines, and tax distribution.
 */
export function allocate(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`cannot allocate across ${parts} parts`);
  }
  const n = BigInt(parts);
  const base = amount / n;
  const remainder = amount - base * n;
  const step = remainder < 0n ? -1n : 1n;
  let left = remainder < 0n ? -remainder : remainder;

  return Array.from({ length: parts }, () => {
    const extra = left > 0n ? step : 0n;
    if (left > 0n) left -= 1n;
    return money(base + extra);
  });
}

/**
 * Allocate proportionally to weights, with the remainder going to the largest
 * weights first. Used to spread a cart level discount across lines so that the
 * line amounts still sum to the cart total.
 */
export function allocateByWeight(amount: Money, weights: readonly Money[]): Money[] {
  const total = sum(weights);
  if (total === 0n) return allocate(amount, weights.length);

  const shares = weights.map((w) => (amount * w) / total);
  let remainder = amount - shares.reduce((a, b) => a + b, 0n);

  const order = weights
    .map((w, i) => ({ i, w }))
    .sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));

  const step = remainder < 0n ? -1n : 1n;
  let left = remainder < 0n ? -remainder : remainder;
  for (const { i } of order) {
    if (left === 0n) break;
    shares[i] = shares[i]! + step;
    left -= 1n;
  }
  return shares.map((s) => money(s));
}

/** Integer division rounding half away from zero. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const doubled = (n % d) * 2n;
  const rounded = doubled >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Serialization. JSON has no bigint and `JSON.stringify` throws on one, so
 * money crosses the wire as a digit string. A number would be silently lossy
 * above 2^53 and, worse, would invite the client to do float arithmetic on it.
 */
export const serialize = (value: Money): string => value.toString();
export const deserialize = (value: string): Money => money(value);

/** Postgres `numeric(14,6)` cost values. Kept fractional until posted. */
export function decimal(value: string | number): Decimal {
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(text)) {
    throw new MoneyError(`"${text}" is not a valid cost (max six decimal places)`);
  }
  return text as Decimal;
}

/** Post a fractional cost to minor units, rounding half up exactly once. */
export function costToMinor(cost: Decimal | string, quantity = 1): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(cost).trim());
  if (!match) throw new MoneyError(`"${cost}" is not a valid cost`);
  const [, sign, whole, frac = ''] = match;
  const scale = 10n ** BigInt(frac.length);
  const scaled = BigInt(whole!) * scale + BigInt(frac || '0');
  const minor = divideRoundHalfUp(scaled * MINOR_UNITS_PER_MAJOR * BigInt(quantity), scale);
  return money(sign === '-' ? -minor : minor);
}
