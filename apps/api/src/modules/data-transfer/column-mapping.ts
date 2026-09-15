/**
 * Which column in someone's spreadsheet is which field of ours.
 *
 * Three tiers, cheapest first, exactly like invoice line matching:
 *
 *   1. an exact header match after normalization ("Unit Cost" == "unit_cost")
 *   2. a known alias for that field ("UPC" means barcode, "Retail" means price)
 *   3. AI, for whatever is left -- see `AiService.mapColumns`
 *
 * Tiers 1 and 2 are free, deterministic and cover every export whose author
 * used ordinary words. AI is asked only about the leftovers, and its answers
 * are marked so the review screen can say which ones came from a guess. No
 * tier writes anything: the mapping is always shown for confirmation, because
 * a wrong column on a catalog migration corrupts everything in one click.
 */

export type ImportEntity = 'item' | 'customer';

export interface TargetField {
  key: string;
  label: string;
  /** Shown on the review screen so a person can tell what belongs in the column. */
  hint: string;
  /** A row without this is skipped rather than imported. */
  required?: boolean;
  aliases: readonly string[];
}

/**
 * Deliberately not every column in the catalog. These are the fields a
 * migration export or a vendor price list actually carries -- adding more
 * would lengthen the review screen without anything ever mapping to them.
 */
export const ITEM_FIELDS: readonly TargetField[] = [
  {
    key: 'sku',
    label: 'SKU / UPC',
    hint: 'The code that identifies the item. Used to decide whether a row is new or an update.',
    required: true,
    aliases: ['sku', 'upc', 'item code', 'item number', 'itemid', 'item id', 'barcode', 'code', 'plu code'],
  },
  {
    key: 'name',
    label: 'Product name',
    hint: 'Required for a row that creates a new item.',
    aliases: ['name', 'product', 'product name', 'description', 'item name', 'item description', 'title'],
  },
  {
    key: 'variant_name',
    label: 'Variant',
    hint: 'The flavor, size or color. Blank for an item with only one version.',
    aliases: ['variant', 'flavor', 'flavour', 'size', 'color', 'colour', 'style', 'option'],
  },
  { key: 'brand', label: 'Brand', hint: 'Created if it does not exist yet.', aliases: ['brand', 'manufacturer', 'vendor brand', 'make'] },
  { key: 'category', label: 'Category', hint: 'Matched by name; a row naming an unknown category is reported, not invented.', aliases: ['category', 'dept', 'department', 'class', 'group', 'type'] },
  {
    key: 'price',
    label: 'Retail price',
    hint: 'What the customer pays, in dollars.',
    aliases: ['price', 'retail', 'retail price', 'sell price', 'selling price', 'unit price', 'msrp', 'list price'],
  },
  {
    key: 'cost',
    label: 'Unit cost',
    hint: 'What one unit costs you, in dollars.',
    aliases: ['cost', 'unit cost', 'item cost', 'wholesale', 'wholesale cost', 'buy price', 'net cost'],
  },
  { key: 'case_cost', label: 'Case cost', hint: 'What a full case costs, in dollars.', aliases: ['case cost', 'case price', 'box cost', 'carton cost', 'master cost'] },
  { key: 'case_quantity', label: 'Units per case', hint: 'How many sellable units are in a case.', aliases: ['case quantity', 'case qty', 'units per case', 'pack', 'pack size', 'case pack', 'per case', 'uom'] },
  { key: 'plu', label: 'PLU', hint: 'Keypad code for items rung up without a barcode.', aliases: ['plu', 'plu number', 'keypad', 'quick key'] },
  { key: 'vendor_sku', label: "Vendor's SKU", hint: "The supplier's own code for this item.", aliases: ['vendor sku', 'supplier sku', 'vendor item', 'vendor code', 'supplier code', 'vendor part'] },
  { key: 'reorder_point', label: 'Reorder point', hint: 'Stock level that should trigger reordering.', aliases: ['reorder point', 'reorder', 'min qty', 'minimum', 'par', 'par level', 'restock level'] },
];

export const CUSTOMER_FIELDS: readonly TargetField[] = [
  { key: 'first_name', label: 'First name', hint: '', aliases: ['first name', 'firstname', 'given name', 'fname'] },
  { key: 'last_name', label: 'Last name', hint: '', aliases: ['last name', 'lastname', 'surname', 'family name', 'lname'] },
  {
    key: 'full_name',
    label: 'Full name',
    hint: 'Use when the sheet has one name column. Split on the last space.',
    aliases: ['name', 'full name', 'customer', 'customer name', 'contact', 'contact name'],
  },
  {
    key: 'phone',
    label: 'Phone',
    hint: 'A customer needs a phone or an email; a row with neither is skipped.',
    aliases: ['phone', 'mobile', 'cell', 'telephone', 'phone number', 'contact number'],
  },
  { key: 'email', label: 'Email', hint: '', aliases: ['email', 'e mail', 'email address', 'mail'] },
  {
    key: 'birthday',
    label: 'Birthday',
    hint: 'Month and day only — the year is not stored. Accepts 04/12, 4-12 or 2001-04-12.',
    aliases: ['birthday', 'birth date', 'birthdate', 'dob', 'date of birth', 'bday'],
  },
  { key: 'tags', label: 'Tags', hint: 'Comma or semicolon separated.', aliases: ['tags', 'tag', 'labels', 'groups', 'segment'] },
  { key: 'notes', label: 'Notes', hint: '', aliases: ['notes', 'note', 'comment', 'comments', 'memo'] },
];

export function fieldsFor(entity: ImportEntity): readonly TargetField[] {
  return entity === 'item' ? ITEM_FIELDS : CUSTOMER_FIELDS;
}

/** `"Unit Cost"`, `"unit-cost"` and `"unit_cost"` are one header to a human; lowercase word tokens are what make them one here. */
function tokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A single-word alias ("sku") matches a header if any of its tokens equals
 * that word, so "Item SKU" still matches. A multi-word alias ("unit cost")
 * needs those words adjacent and in order, so it doesn't fire on a header
 * that merely contains both somewhere.
 */
function headerMatches(header: string, alias: string): boolean {
  const headerTokens = tokens(header);
  const aliasTokens = tokens(alias);
  if (aliasTokens.length === 0) return false;
  return aliasTokens.length === 1
    ? headerTokens.includes(aliasTokens[0]!)
    : headerTokens.join(' ').includes(aliasTokens.join(' '));
}

export interface MappingResult {
  /** field key -> source column name. A field nothing mapped to is absent. */
  mapping: Record<string, string>;
  /** Fields with no column found. These are what AI is asked about. */
  unmapped: string[];
  /** Columns no field claimed. These are what AI is offered to choose from. */
  unusedColumns: string[];
}

/**
 * Tiers 1 and 2, resolved most-specific-first rather than in field order.
 *
 * Specificity beats declaration order because a column can only be claimed
 * once, and whichever field asks first wins it. Ordering the field list by
 * hand to arrange that is exactly the kind of load-bearing invisible detail
 * that breaks the first time someone adds a field in the wrong place -- and
 * it did: a "Pack Size" column went to `variant_name`, whose single-word
 * alias "size" happened to be declared above `case_quantity`'s two-word
 * "pack size", which is plainly the better match.
 *
 * So the passes are, in order:
 *
 *   1. exact equality with the field key ("unit_cost" == "Unit Cost")
 *   2. a multi-word alias ("pack size", "item description")
 *   3. a single-word alias ("sku", "size", "cost")
 *
 * A multi-word alias is inherently more specific than a single word, so this
 * ranking holds generally rather than for the one case that exposed it.
 */
export function mapColumnsDeterministically(entity: ImportEntity, headers: string[]): MappingResult {
  const fields = fieldsFor(entity);
  const mapping: Record<string, string> = {};
  const claimed = new Set<string>();

  const claim = (fieldKey: string, header: string) => {
    mapping[fieldKey] = header;
    claimed.add(header);
  };

  // Exact normalized equality with the field's own key. A sheet whose column
  // is literally "Cost" is `cost`, even though `case_cost` would also happily
  // match a header containing that word.
  for (const field of fields) {
    const exact = headers.find((h) => !claimed.has(h) && tokens(h).join(' ') === tokens(field.key).join(' '));
    if (exact) claim(field.key, exact);
  }

  for (const multiWord of [true, false]) {
    for (const field of fields) {
      if (mapping[field.key]) continue;
      const aliases = field.aliases.filter((alias) => (tokens(alias).length > 1) === multiWord);
      if (aliases.length === 0) continue;
      const found = headers.find((h) => !claimed.has(h) && aliases.some((alias) => headerMatches(h, alias)));
      if (found) claim(field.key, found);
    }
  }

  return {
    mapping,
    unmapped: fields.filter((f) => !mapping[f.key]).map((f) => f.key),
    unusedColumns: headers.filter((h) => !claimed.has(h)),
  };
}

/**
 * Drops anything the caller's mapping names that isn't a real field or a real
 * column. A mapping arrives from a browser form and from a model, and neither
 * is a reason to trust a key: an unknown field would be silently ignored
 * downstream, and an unknown column would read as `undefined` on every row.
 */
export function sanitizeMapping(
  entity: ImportEntity,
  headers: string[],
  proposed: Record<string, unknown>,
): Record<string, string> {
  const valid = new Set(fieldsFor(entity).map((f) => f.key));
  const columns = new Set(headers);
  const clean: Record<string, string> = {};
  const used = new Set<string>();

  for (const [field, column] of Object.entries(proposed)) {
    if (!valid.has(field) || typeof column !== 'string') continue;
    if (!columns.has(column) || used.has(column)) continue;
    clean[field] = column;
    used.add(column);
  }
  return clean;
}
