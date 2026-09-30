/**
 * Which flavor the AI found is the item the shop already has.
 *
 * Most of the catalog came over from the old system one item per flavor, with
 * the flavor in the product name and no variant name at all: "Celsius
 * Sparkling Orange 12Oz", one variant, carrying the barcode, the price and the
 * sales history. The AI draft turns that into "Celsius Sparkling 12oz" with
 * flavors Orange, Kiwi Guava and so on. Matched by variant name alone, Orange
 * looks new, and saving the draft added a second, empty Orange next to the
 * real one.
 *
 * So an unnamed variant is matched to the flavor its product's current name
 * spells out. Only when it is unambiguous: exactly one unnamed variant, and a
 * flavor that appears in the name as whole words. When several do ("Blood
 * Orange" and "Orange" in "Blood Orange 12Oz") the longest wins, since the
 * shorter one is part of it. And when the product has a single variant and
 * the draft a single flavor, that flavor is the item whatever the name says.
 */
export function matchUnnamedVariant<F extends { name: string; existing_variant_id: string | null }>(
  productName: string,
  flavors: F[],
  unnamed: { id: string }[],
  variantCount: number,
): { flavor: F; variantId: string } | null {
  if (unnamed.length !== 1) return null;
  const variantId = unnamed[0]!.id;
  const open = flavors.filter((f) => !f.existing_variant_id);

  const name = ` ${words(productName)} `;
  const inName = open
    .filter((f) => words(f.name) && name.includes(` ${words(f.name)} `))
    .sort((a, b) => words(b.name).length - words(a.name).length);
  if (inName[0]) return { flavor: inName[0], variantId };

  if (variantCount === 1 && flavors.length === 1 && open.length === 1) return { flavor: open[0]!, variantId };
  return null;
}

/** Lower case, letters and digits only, single spaces: "Orange 12Oz" and "orange-12oz" read alike. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
