/**
 * Retail margin arithmetic, in one place because the item form, the catalog
 * list and the price groups page all have to agree about it.
 *
 * Mind the units, which are not the same on both sides and are the easiest
 * thing here to get wrong: a **cost** is a decimal string in dollars
 * (`numeric(14,6)`, so "9.850000"), while a **retail price** is an integer
 * string in minor units ("2399" is $23.99). Everything below takes those as
 * they arrive from the API and returns plain dollars.
 */

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function retailDollars(priceMinor: string | null | undefined): number | null {
  const minor = toNumber(priceMinor);
  return minor === null ? null : minor / 100;
}

/**
 * What one unit costs once the case discount is taken off:
 * `(case cost - case discount) / units per case`. Null when there's no case
 * cost on file, which is the signal to fall back to the variant's own `cost`.
 */
export function costPerUnit(input: {
  caseCost: string | null | undefined;
  caseDiscount: string | null | undefined;
  unitsPerCase: number | string | null | undefined;
}): number | null {
  const caseCost = toNumber(input.caseCost);
  if (caseCost === null) return null;
  const units = toNumber(String(input.unitsPerCase ?? ""));
  if (units === null || units <= 0) return null;
  const discount = toNumber(input.caseDiscount) ?? 0;
  return (caseCost - discount) / units;
}

/** A rebate is per case, so it only reaches a unit after the same division. */
export function rebatePerUnit(input: {
  caseRebate: string | null | undefined;
  unitsPerCase: number | string | null | undefined;
}): number {
  const rebate = toNumber(input.caseRebate) ?? 0;
  const units = toNumber(String(input.unitsPerCase ?? ""));
  if (rebate === 0 || units === null || units <= 0) return 0;
  return rebate / units;
}

/**
 * Margin as retail takes it: the share of the selling price that isn't cost.
 * Not markup -- $4 bought and $5 sold is a 20% margin and a 25% markup, and
 * confusing the two is how a shop thinks it's making more than it is.
 */
export function marginPercent(retail: number | null, unitCost: number | null): number | null {
  if (retail === null || unitCost === null || retail <= 0) return null;
  return ((retail - unitCost) / retail) * 100;
}

/** The retail price that would hit a target margin: `cost / (1 - margin)`. */
export function retailForMargin(unitCost: number | null, marginTarget: string | null | undefined): number | null {
  const target = toNumber(marginTarget);
  if (unitCost === null || target === null || target < 0 || target >= 100) return null;
  return unitCost / (1 - target / 100);
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function formatDollars(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

/** Everything the item form and the lists show, derived together so they can't disagree. */
export function marginSummary(input: {
  caseCost: string | null | undefined;
  caseDiscount: string | null | undefined;
  caseRebate: string | null | undefined;
  unitsPerCase: number | string | null | undefined;
  /** The variant's own stored unit cost, used when there's no case cost. */
  unitCost: string | null | undefined;
  priceMinor: string | null | undefined;
}) {
  const derived = costPerUnit(input);
  const effectiveCost = derived ?? toNumber(input.unitCost);
  const retail = retailDollars(input.priceMinor);
  const afterRebate =
    effectiveCost === null ? null : effectiveCost - rebatePerUnit(input);

  return {
    /** Null when nothing on file says what this costs. */
    unitCost: effectiveCost,
    /** True when the case fields produced it rather than the stored `cost`. */
    isDerived: derived !== null,
    retail,
    margin: marginPercent(retail, effectiveCost),
    marginAfterRebate: marginPercent(retail, afterRebate),
    belowCost: retail !== null && effectiveCost !== null && retail < effectiveCost,
  };
}
