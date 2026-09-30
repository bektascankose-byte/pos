/**
 * Send to POS: what is waiting, in words, and whether it can go.
 *
 * Pure functions over the two jsonb shapes migration 0034 defines: a variant
 * as the registers would get it now (`pos_live_variants`) and as they were
 * last sent it (`pos_catalog_variants`). No database here, so every rule the
 * Send page shows a person can be tested on its own.
 */

/** One variant's register row, as `pos_live_variants.payload` builds it. */
export interface VariantPayload {
  id: string;
  product_id: string;
  product_name: string;
  variant_name: string | null;
  sku: string;
  plu: string | null;
  brand_id: string | null;
  brand_name: string | null;
  category_id: string | null;
  tax_category_id: string | null;
  case_quantity: number | string | null;
  sort_order: number;
  is_default: boolean;
  status: string;
  minimum_age: number | null;
  id_scan_required: boolean;
  regulated_class: string | null;
  image_url: string | null;
}

export interface BarcodeRow {
  id: string;
  variant_id: string;
  barcode: string;
  kind: string;
  units: string;
  is_primary: boolean;
}

export interface PriceRow {
  id: string;
  variant_id: string;
  store_id: string | null;
  kind: string;
  price_minor: string;
  effective_from: string;
  effective_to: string | null;
}

export interface VariantState {
  payload: VariantPayload;
  barcodes: BarcodeRow[];
  prices: PriceRow[];
}

/** One variant on either side of a send. `live` null: removed. `sent` null: never sent. */
export interface VariantPair {
  variant_id: string;
  product_id: string;
  live: VariantState | null;
  sent: VariantState | null;
}

/** Display names for the ids a payload carries. */
export interface Names {
  categories: Map<string, string>;
  taxCategories: Map<string, string>;
  stores: Map<string, string>;
}

export type ChangeKind = 'new' | 'changed' | 'removed';

export interface ProductDiff {
  kind: ChangeKind;
  changes: string[];
  problems: string[];
  sendable: boolean;
}

/**
 * Key order independent JSON, so two rows that jsonb would call equal are
 * equal here too whatever order the driver happened to build their keys in.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether sending this variant would change anything on a register. */
export function differs(pair: VariantPair): boolean {
  const { live, sent } = pair;
  if (!live || !sent) return live !== sent;
  return (
    canonical(live.payload) !== canonical(sent.payload) ||
    canonical(live.barcodes) !== canonical(sent.barcodes) ||
    canonical(live.prices) !== canonical(sent.prices)
  );
}

/** What a person calls this variant: its flavor, or the product itself for a single item. */
export function variantLabel(state: VariantState): string {
  const name = state.payload.variant_name?.trim();
  return name ? name : state.payload.product_name;
}

export function formatMoney(minor: string | number): string {
  return `$${(Number(minor) / 100).toFixed(2)}`;
}

function isCurrent(p: PriceRow, now: Date): boolean {
  const t = now.getTime();
  return Date.parse(p.effective_from) <= t && (p.effective_to === null || Date.parse(p.effective_to) > t);
}

/**
 * The regular price in force right now, per store. The key is the store id,
 * or '' for the organization wide price every store falls back to.
 */
export function currentRegularPrices(prices: PriceRow[], now: Date): Map<string, string> {
  const best = new Map<string, PriceRow>();
  for (const p of prices) {
    if (p.kind !== 'regular' || !isCurrent(p, now)) continue;
    const key = p.store_id ?? '';
    const held = best.get(key);
    if (!held || Date.parse(p.effective_from) > Date.parse(held.effective_from)) best.set(key, p);
  }
  return new Map([...best].map(([key, p]) => [key, p.price_minor]));
}

/**
 * Why this variant cannot go to the registers yet, or null when it can.
 *
 * A price, and only a price. A register refuses to sell an item nobody
 * priced, so sending one puts a tile on the till that says no.
 *
 * A barcode is deliberately not required, though it used to be. The shop
 * lists a whole line long before every flavor of it is physically in hand:
 * the AI draft finds the real lineup, the packets arrive over weeks, and a
 * flavor nobody has yet cannot have a code copied off it. Meanwhile a flavor
 * with no code is perfectly sellable by tapping its tile, which is how the
 * register's folders work anyway. Holding the whole line back until every
 * flavor had a barcode meant none of it reached the till, which is worse than
 * a tile that has to be tapped. Codes get added as stock turns up and the
 * item starts scanning from the next Send.
 */
export function notReadyReason(live: VariantState, now: Date): string | null {
  const hasPrice = currentRegularPrices(live.prices, now).size > 0;
  return hasPrice ? null : `${variantLabel(live)} needs a price`;
}

/** "A, B, C" or "A, B, C, D, E, F and 4 more". No serial comma. */
export function listNames(names: string[], max = 6): string {
  if (names.length <= max) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function ageText(p: VariantPayload): string {
  if (p.minimum_age) return `${p.minimum_age}+${p.id_scan_required ? ' with ID scan' : ''}`;
  return p.id_scan_required ? 'ID scan' : 'none';
}

/**
 * A stricter age check is already on the registers the moment it is saved
 * (the snapshot takes the stricter of sent and live), so the Send page says
 * so rather than implying the shop is exposed until someone presses Send.
 */
function isStricter(live: VariantPayload, sent: VariantPayload): boolean {
  return (live.minimum_age ?? 0) >= (sent.minimum_age ?? 0) && (live.id_scan_required || !sent.id_scan_required);
}

function barcodeKey(b: BarcodeRow): string {
  return `${b.barcode}|${Number(b.units)}|${b.kind}`;
}

function barcodeWords(b: BarcodeRow): string {
  const units = Number(b.units);
  return units === 1 ? `barcode ${b.barcode}` : `carton ${b.barcode} (${units} units)`;
}

/**
 * One product's waiting changes, in the words the Send page shows.
 *
 * `pairs` is every variant of the product on either side, changed or not:
 * whether it is new or coming off the registers depends on the whole
 * product, not just the variants that moved.
 */
export function describeProduct(pairs: VariantPair[], names: Names, now: Date): ProductDiff {
  const liveCount = pairs.filter((p) => p.live).length;
  const sentCount = pairs.filter((p) => p.sent).length;
  const kind: ChangeKind = sentCount === 0 ? 'new' : liveCount === 0 ? 'removed' : 'changed';

  const changes: string[] = [];
  const problems: string[] = [];
  const add = (line: string) => {
    if (!changes.includes(line)) changes.push(line);
  };
  let sendable = false;

  const ordered = [...pairs].sort(
    (a, b) => (a.live ?? a.sent)!.payload.sort_order - (b.live ?? b.sent)!.payload.sort_order,
  );

  if (kind === 'new') {
    const labels = ordered.map((p) => variantLabel(p.live!));
    add(labels.length > 1 ? `New item with ${labels.length} flavors: ${listNames(labels)}` : 'New item');
  }
  if (kind === 'removed') add('Comes off the registers');

  const reorder: string[] = [];
  const photos: string[] = [];
  const multiStore = names.stores.size > 1;
  const category = (id: string | null) => (id ? names.categories.get(id) ?? 'another category' : 'none');
  const tax = (id: string | null) => (id ? names.taxCategories.get(id) ?? 'another tax category' : 'none');

  for (const pair of ordered) {
    if (!differs(pair)) continue;
    const { live, sent } = pair;

    if (live) {
      const reason = notReadyReason(live, now);
      if (reason) {
        problems.push(sent ? `${reason}, so the registers keep what they have` : reason);
      } else {
        sendable = true;
      }
    } else {
      sendable = true;
    }

    if (live && !sent) {
      if (kind !== 'new') add(`Adds ${variantLabel(live)}`);
      continue;
    }
    if (!live && sent) {
      if (kind !== 'removed') add(`Removes ${variantLabel(sent)}`);
      continue;
    }
    if (!live || !sent) continue;

    // Whether this pair's difference was put into words. Product level lines
    // are shared by every variant and only listed once, so a line being
    // added is not the test.
    let noted = false;
    const note = (line: string) => {
      noted = true;
      add(line);
    };
    const l = live.payload;
    const s = sent.payload;
    const label = variantLabel(live);

    // The product, repeated on every variant.
    if (l.product_name !== s.product_name) note(`Renamed from ${s.product_name} to ${l.product_name}`);
    if (l.brand_name !== s.brand_name) note(`Brand ${s.brand_name ?? 'none'} to ${l.brand_name ?? 'none'}`);
    if (l.category_id !== s.category_id) note(`Category ${category(s.category_id)} to ${category(l.category_id)}`);
    if (l.tax_category_id !== s.tax_category_id) {
      note(`Tax category ${tax(s.tax_category_id)} to ${tax(l.tax_category_id)}`);
    }
    if (l.minimum_age !== s.minimum_age || l.id_scan_required !== s.id_scan_required) {
      const already = isStricter(l, s) ? ' (already enforced on the registers)' : '';
      note(`Age check ${ageText(s)} to ${ageText(l)}${already}`);
    }
    if (l.regulated_class !== s.regulated_class) {
      note(`Regulated as ${l.regulated_class ?? 'nothing'} instead of ${s.regulated_class ?? 'nothing'}`);
    }

    // The variant itself.
    if (l.variant_name !== s.variant_name && l.product_name === s.product_name) {
      note(`${variantLabel(sent)} renamed to ${label}`);
    }
    if (l.sku !== s.sku) note(`${label} SKU ${s.sku} to ${l.sku}`);
    if (l.plu !== s.plu) note(`${label} PLU ${s.plu ?? 'none'} to ${l.plu ?? 'none'}`);
    if (String(l.case_quantity ?? '') !== String(s.case_quantity ?? '')) {
      note(`${label} case size ${s.case_quantity ?? 'none'} to ${l.case_quantity ?? 'none'}`);
    }
    if (l.is_default && !s.is_default) note(`${label} is now the default flavor`);
    if (l.sort_order !== s.sort_order) {
      noted = true;
      reorder.push(label);
    }
    if (l.image_url !== s.image_url) {
      noted = true;
      photos.push(label);
    }

    const sentCodes = new Map(sent.barcodes.map((b) => [barcodeKey(b), b]));
    const liveCodes = new Map(live.barcodes.map((b) => [barcodeKey(b), b]));
    for (const [key, b] of liveCodes) if (!sentCodes.has(key)) note(`${label} ${barcodeWords(b)} added`);
    for (const [key, b] of sentCodes) if (!liveCodes.has(key)) note(`${label} ${barcodeWords(b)} removed`);

    const livePrices = currentRegularPrices(live.prices, now);
    const sentPrices = currentRegularPrices(sent.prices, now);
    for (const store of new Set([...livePrices.keys(), ...sentPrices.keys()])) {
      const was = sentPrices.get(store);
      const is = livePrices.get(store);
      if (was === is) continue;
      const where = multiStore && store ? ` at ${names.stores.get(store) ?? 'one store'}` : '';
      note(`${label} price ${was ? formatMoney(was) : 'none'} to ${is ? formatMoney(is) : 'none'}${where}`);
    }
    if (!noted && canonical(live.prices) !== canonical(sent.prices)) note(`${label} scheduled price change`);
    if (!noted && canonical(live.barcodes) !== canonical(sent.barcodes)) note(`${label} main barcode changed`);
    if (!noted) note(`${label} details updated`);
  }

  if (reorder.length) add('Flavor order changed');
  if (photos.length === 1) add(`${photos[0]} photo updated`);
  else if (photos.length > 1) {
    add(photos.length === liveCount ? 'Photos updated for every flavor' : `Photos updated for ${listNames(photos)}`);
  }

  return { kind, changes, problems, sendable };
}

export interface SendPlan {
  /** Variants whose live state goes to the registers, replacing any sent copy. */
  upsert: string[];
  /** Variants taken off the registers. */
  remove: string[];
  added: number;
  changed: number;
  heldBack: { product_id: string; variant_name: string; reason: string }[];
}

/**
 * What pressing Send does to these variants. Everything ready goes; anything
 * not ready stays exactly as the registers have it (or off them, if it was
 * never sent), and is reported so the person knows what did not go and why.
 */
export function planSend(pairs: VariantPair[], now: Date): SendPlan {
  const plan: SendPlan = { upsert: [], remove: [], added: 0, changed: 0, heldBack: [] };
  for (const pair of pairs) {
    if (!differs(pair)) continue;
    const { live, sent } = pair;
    if (!live) {
      plan.remove.push(pair.variant_id);
      continue;
    }
    const reason = notReadyReason(live, now);
    if (reason) {
      plan.heldBack.push({ product_id: pair.product_id, variant_name: variantLabel(live), reason });
      continue;
    }
    plan.upsert.push(pair.variant_id);
    if (sent) plan.changed += 1;
    else plan.added += 1;
  }
  return plan;
}
