/**
 * Tidying product names that came out of somebody else's system.
 *
 * A legacy item file is typed by whoever was on the till that day, over
 * years. Half of it is lowercase, some is shouted, a few have UTF-8 read as
 * Latin-1 so `®` arrived as `Â®`, and a handful are just "zous".
 *
 * This fixes only what can be fixed **without inventing anything**:
 * whitespace, mojibake, measurement units, and capitalisation. The rule for
 * capitals is per-word, not per-name: a word someone typed with capitals in
 * it is theirs and is never touched, so "FOGER SwitchPro" and "SS Banana
 * Smash" survive intact, while the lowercase half of "Marlboro blk sp blend"
 * gets tidied. A name that is *entirely* upper case is the one exception --
 * shouting carries no information, so it is title cased whole.
 *
 * What it deliberately does NOT do is guess. "bule kush cake hybird" stays
 * misspelled and "happy" stays meaningless, because a rule that corrects
 * those would also quietly rewrite real brand names. Those need a person or
 * an explicitly-reviewed suggestion, not a regex.
 */

/** Tokens that keep their own shape whatever the surrounding casing. */
const ACRONYMS = new Set([
  'THC', 'CBD', 'CBG', 'CBN', 'CBC', 'THCA', 'THCP', 'THCV', 'HHC', 'D8', 'D9', 'D10',
  'ENDS', 'LED', 'USB', 'DNA', 'RDA', 'RTA', 'RBA', 'PG', 'VG', 'XL', 'XXL', 'OG', 'ID',
  'BOGO', 'MTL', 'DTL', 'IPA', 'PB', 'AAA', 'AA', 'C4', 'TV', 'HD', 'US', 'UK',
]);

/** Units that are conventionally lowercase after a number. */
const LOWER_UNITS = new Set(['mg', 'ml', 'g', 'kg', 'oz', 'lb', 'ct', 'pk', 'pc', 'pcs', 'pks', 'in', 'mm', 'cm']);

/** Small words that stay lowercase unless they lead. */
const MINOR_WORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'with', 'by']);

/**
 * Undo UTF-8 bytes that were read as Latin-1 — the `Â®` / `â€™` family.
 *
 * Only attempted when those telltale sequences are present: running it
 * blindly would corrupt names that contain a legitimate `Ã`.
 */
function fixMojibake(value: string): string {
  if (!/Â|â€|Ã/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    // Only accept the repair if it actually removed the damage; a false
    // positive would otherwise make things worse than it found them.
    return /Â|â€|�/.test(repaired) ? value : repaired;
  } catch {
    return value;
  }
}

/** `5k` → `5K`, `60ML` → `60ml`, `10500MG` → `10500mg`. */
function normalizeMeasurement(token: string): string | null {
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]+)$/.exec(token);
  if (!match) return null;
  const [, number, rawUnit] = match;
  const unit = rawUnit!.toLowerCase();
  if (LOWER_UNITS.has(unit)) return `${number}${unit}`;
  // A bare "k" as in 5K puffs reads better capitalised, and is the one unit
  // in this trade people write that way.
  if (unit === 'k') return `${number}K`;
  if (unit === 'mah') return `${number}mAh`;
  return null;
}

function capitalizeWord(word: string, isFirst: boolean): string {
  if (!word) return word;

  const measurement = normalizeMeasurement(word);
  if (measurement) return measurement;

  const upper = word.toUpperCase();
  if (ACRONYMS.has(upper)) return upper;

  const lower = word.toLowerCase();
  if (!isFirst && MINOR_WORDS.has(lower)) return lower;

  // Anything with a digit in it (3in1, 1g, 6mg60ml) is left alone beyond
  // lowercasing: these are codes and sizes, and title-casing them produces
  // things like "3In1".
  if (/\d/.test(word)) return lower;

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Words, for capitalisation purposes. Hyphens and slashes are boundaries, so
 * "zig-zag" becomes "Zig-Zag" rather than "Zig-zag"; apostrophes are NOT, or
 * "100's" comes back as "100'S".
 */
const WORD = /[A-Za-z0-9.'’]+/g;

/**
 * @param shouting the whole name is upper case, so no word's capitals mean
 *   anything and every one of them can be recased.
 */
function titleCase(value: string, shouting: boolean): string {
  let wordIndex = 0;
  return value.replace(WORD, (word) => {
    const isFirst = wordIndex++ === 0;
    // Someone's deliberate capitals are left alone -- but units are still
    // regularised, since "6MG/100ML" is nobody's styling choice.
    if (!shouting && /[A-Z]/.test(word)) return normalizeMeasurement(word) ?? word;
    return capitalizeWord(word, isFirst);
  });
}

export interface CleanedName {
  name: string;
  /** True when nothing could be made of it — empty, or a bare barcode. */
  unusable: boolean;
}

/**
 * The whole tidy-up, in the order the fixes depend on each other.
 */
export function cleanProductName(raw: string | null | undefined): CleanedName {
  const value = fixMojibake(String(raw ?? ''))
    .replace(/\s+/g, ' ')
    .trim();

  if (!value) return { name: '', unusable: true };

  // A name that is only digits is a barcode somebody pasted into the wrong
  // column. Kept as-is rather than prettified, and flagged: calling it a
  // product name would be a lie, and the row is still worth keeping for the
  // price and department on it.
  if (/^\d{6,}$/.test(value)) return { name: value, unusable: true };

  const shouting = value === value.toUpperCase() && /[A-Z]/.test(value);
  const name = titleCase(value, shouting);

  return { name, unusable: name.length < 4 };
}
