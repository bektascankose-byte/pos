/**
 * Sales tax on a line, the way the register charges it.
 *
 * The register applies one combined rate to each line's taxable amount, half
 * up, once -- `Cart.kt`'s `taxable.applyRate(taxRate)` -- and snapshots it as a
 * single component. This does the same thing from the rates table, so an order
 * handed over in the back office carries exactly the tax the same basket would
 * have carried at the counter.
 *
 * Combining first matters. Rounding 6.25% and 2% separately and adding the
 * results can land a cent away from rounding 8.25% once, and a customer
 * comparing an online receipt with a counter receipt for the same item would
 * be right to ask why.
 */

import { applyRate, money, type Money } from './money.js';

/** One ad valorem rate in force for a line. */
export interface ApplicableRate {
  name: string;
  /** Decimal string, e.g. "0.082500". Never a float. */
  rate: string;
}

/** The shape the register uploads in `sale_lines.tax_snapshot`. */
export interface TaxSnapshotComponent {
  name: string;
  rate: string;
  amount_minor: string;
}

export interface LineTax {
  tax: Money;
  snapshot: TaxSnapshotComponent[];
}

/**
 * Add decimal rate strings without ever leaving integers.
 *
 * "0.0625" + "0.02" is "0.0825", exactly. Trailing zeros are trimmed so the
 * result reads the way a person would write the rate.
 */
export function combineRates(rates: readonly string[]): string {
  let scale = 0;
  const parsed = rates.map((rate) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
    if (!match) throw new Error(`"${rate}" is not a valid tax rate`);
    const frac = match[2] ?? '';
    scale = Math.max(scale, frac.length);
    return { whole: match[1]!, frac };
  });

  const factor = 10n ** BigInt(scale);
  const total = parsed.reduce(
    (sum, { whole, frac }) => sum + BigInt(whole) * factor + BigInt(frac.padEnd(scale, '0') || '0'),
    0n,
  );

  const whole = total / factor;
  const frac = (total % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** A line a charge is spread across: its amount, and the rates it is taxed at. */
export interface ChargeLine {
  amount: Money;
  rates: readonly ApplicableRate[];
}

/**
 * Sales tax on a charge that follows the goods it came with, such as a
 * delivery fee.
 *
 * Texas taxes a delivery charge when what is delivered is taxable, and in
 * proportion when only some of it is. So the charge is shared out across the
 * lines by their amounts -- whole cents, the leftover cents going to the
 * largest remainders so the shares add up to the charge exactly -- and each
 * share is taxed as its own line would be. A share belonging to an untaxed
 * line carries no tax. Whether a particular charge is taxable at all is a
 * question for the shop's accountant; this only does the arithmetic the
 * answer implies.
 */
export function taxForCharge(charge: Money, lines: readonly ChargeLine[]): LineTax {
  const total = lines.reduce((sum, line) => sum + (line.amount > 0n ? line.amount : 0n), 0n);
  if (charge <= 0n || total <= 0n) return { tax: money(0), snapshot: [] };

  const parts = lines.map((line, index) => {
    const amount = line.amount > 0n ? line.amount : 0n;
    const scaled = charge * amount;
    return { index, share: scaled / total, remainder: scaled % total };
  });
  let leftover = charge - parts.reduce((sum, part) => sum + part.share, 0n);
  for (const part of [...parts].sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index))) {
    if (leftover === 0n) break;
    part.share += 1n;
    leftover -= 1n;
  }

  // Shares taxed at the same rates are added together and taxed once. Taxing
  // each share alone would round each one, and three shares of a dollar at 10%
  // would come to nine cents instead of ten.
  const groups = new Map<string, { rates: readonly ApplicableRate[]; amount: bigint }>();
  for (const part of parts) {
    if (part.share === 0n) continue;
    const rates = lines[part.index]!.rates;
    const key = rates.map((r) => `${r.name}=${r.rate}`).sort().join('|');
    const group = groups.get(key) ?? { rates, amount: 0n };
    group.amount += part.share;
    groups.set(key, group);
  }

  let tax = 0n;
  const snapshot: TaxSnapshotComponent[] = [];
  for (const group of groups.values()) {
    const groupTax = taxForLine(money(group.amount), group.rates);
    tax += groupTax.tax;
    snapshot.push(...groupTax.snapshot);
  }
  return { tax: money(tax), snapshot };
}

/**
 * The tax on one line's taxable amount.
 *
 * No rates means no tax and an empty snapshot, which is also what the register
 * writes for a line whose rate is zero.
 */
export function taxForLine(taxable: Money, rates: readonly ApplicableRate[]): LineTax {
  if (rates.length === 0) return { tax: money(0), snapshot: [] };

  const rate = combineRates(rates.map((r) => r.rate));
  if (/^0(\.0*)?$/.test(rate)) return { tax: money(0), snapshot: [] };

  const tax = applyRate(taxable, rate);
  return {
    tax,
    snapshot: [
      {
        name: rates.length === 1 ? rates[0]!.name : 'Sales Tax',
        rate,
        amount_minor: tax.toString(),
      },
    ],
  };
}
