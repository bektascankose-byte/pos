// Send to POS: the words the page shows and what a press of Send does.
// Built around the product the feature was asked for with, Backwoods Cigars
// 5pk and its flavors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeProduct,
  differs,
  listNames,
  notReadyReason,
  planSend,
  type Names,
  type VariantPair,
  type VariantState,
} from './pos-release-diff.js';

const NOW = new Date('2026-09-30T15:00:00Z');
const PRODUCT = '11111111-1111-7111-8111-111111111111';
const STORE = '22222222-2222-7222-8222-222222222222';
const names: Names = {
  categories: new Map([
    ['c1', 'Cigars'],
    ['c2', 'Cigarillos'],
  ]),
  taxCategories: new Map([['t1', 'Tobacco']]),
  stores: new Map([[STORE, 'Main Street']]),
};

function variant(
  name: string,
  opts: { barcode?: string | null; price?: string | null; sort?: number; image?: string | null } = {},
): VariantState {
  const id = `v-${name.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    payload: {
      id,
      product_id: PRODUCT,
      product_name: 'Backwoods Cigars 5pk',
      variant_name: name,
      sku: opts.barcode ?? `TMP-${id}`,
      plu: null,
      brand_id: 'b1',
      brand_name: 'Backwoods',
      category_id: 'c1',
      tax_category_id: 't1',
      case_quantity: 8,
      sort_order: opts.sort ?? 0,
      is_default: (opts.sort ?? 0) === 0,
      status: 'active',
      minimum_age: 21,
      id_scan_required: false,
      regulated_class: 'tobacco',
      image_url: opts.image ?? null,
    },
    barcodes:
      opts.barcode === null
        ? []
        : [{ id: `b-${id}`, variant_id: id, barcode: opts.barcode ?? '071610000001', kind: 'upc', units: '1.000', is_primary: true }],
    prices:
      opts.price === null
        ? []
        : [
            {
              id: `p-${id}`,
              variant_id: id,
              store_id: null,
              kind: 'regular',
              price_minor: opts.price ?? '1099',
              effective_from: '2026-01-01T00:00:00.000000Z',
              effective_to: null,
            },
          ],
  };
}

function pair(live: VariantState | null, sent: VariantState | null): VariantPair {
  const any = (live ?? sent)!;
  return { variant_id: any.payload.id, product_id: PRODUCT, live, sent };
}

function clone(v: VariantState): VariantState {
  return JSON.parse(JSON.stringify(v)) as VariantState;
}

test('a product nobody touched has nothing waiting', () => {
  const v = variant('Honey Berry');
  assert.equal(differs(pair(v, clone(v))), false);
});

test('a new product lists its flavors and holds back the ones missing a barcode or price', () => {
  const pairs = [
    pair(variant('Honey Berry', { barcode: '071610000011', sort: 0 }), null),
    pair(variant('Rum', { barcode: null, sort: 1 }), null),
    pair(variant('Original', { price: null, sort: 2 }), null),
  ];
  const diff = describeProduct(pairs, names, NOW);
  assert.equal(diff.kind, 'new');
  assert.deepEqual(diff.changes, ['New item with 3 flavors: Honey Berry, Rum and Original']);
  assert.deepEqual(diff.problems, ['Rum needs a barcode', 'Original needs a price']);
  assert.equal(diff.sendable, true);

  const plan = planSend(pairs, NOW);
  assert.deepEqual(plan.upsert, ['v-honey-berry']);
  assert.equal(plan.added, 1);
  assert.deepEqual(
    plan.heldBack.map((h) => h.reason),
    ['Rum needs a barcode', 'Original needs a price'],
  );
});

test('an AI found flavor with nothing filled in cannot be sent', () => {
  const pairs = [pair(variant('Russian Cream', { barcode: null, price: null }), null)];
  const diff = describeProduct(pairs, names, NOW);
  assert.equal(diff.sendable, false);
  assert.deepEqual(diff.problems, ['Russian Cream needs a barcode and a price']);
  assert.deepEqual(planSend(pairs, NOW).upsert, []);
});

test('a price change on something already sent is described with both prices', () => {
  const sent = variant('Honey Berry');
  const live = clone(sent);
  live.prices[0]!.price_minor = '1149';
  live.prices[0]!.id = 'p-new';
  const diff = describeProduct([pair(live, sent)], names, NOW);
  assert.equal(diff.kind, 'changed');
  assert.deepEqual(diff.changes, ['Honey Berry price $10.99 to $11.49']);
  assert.equal(diff.sendable, true);
});

test('an item already on the registers does not need a barcode to take a price change', () => {
  const sent = variant('Loose Leaf', { barcode: null });
  const live = clone(sent);
  live.prices[0]!.price_minor = '499';
  assert.equal(notReadyReason(live, true, NOW), null);
  assert.equal(notReadyReason(live, false, NOW), 'Loose Leaf needs a barcode');
});

test('product level edits are listed once however many flavors carry them', () => {
  const sentA = variant('Honey Berry', { sort: 0 });
  const sentB = variant('Rum', { sort: 1, barcode: '071610000022' });
  const [liveA, liveB] = [clone(sentA), clone(sentB)];
  for (const v of [liveA, liveB]) {
    v.payload.product_name = 'Backwoods Cigars 5 Pack';
    v.payload.category_id = 'c2';
  }
  const diff = describeProduct([pair(liveA, sentA), pair(liveB, sentB)], names, NOW);
  assert.deepEqual(diff.changes, [
    'Renamed from Backwoods Cigars 5pk to Backwoods Cigars 5 Pack',
    'Category Cigars to Cigarillos',
  ]);
});

test('barcodes and cartons added and removed are named', () => {
  const sent = variant('Rum', { barcode: '071610000022' });
  const live = clone(sent);
  live.barcodes.push({ id: 'b2', variant_id: live.payload.id, barcode: '10071610000029', kind: 'case', units: '8.000', is_primary: false });
  const diff = describeProduct([pair(live, sent)], names, NOW);
  assert.deepEqual(diff.changes, ['Rum carton 10071610000029 (8 units) added']);
});

test('a flavor removed in the back office comes off the registers, ready or not', () => {
  const kept = variant('Honey Berry', { sort: 0 });
  const gone = variant('Sweet Aromatic', { sort: 1, barcode: null, price: null });
  const pairs = [pair(kept, clone(kept)), pair(null, gone)];
  const diff = describeProduct(pairs, names, NOW);
  assert.deepEqual(diff.changes, ['Removes Sweet Aromatic']);
  assert.equal(diff.sendable, true);
  const plan = planSend(pairs, NOW);
  assert.deepEqual(plan.remove, ['v-sweet-aromatic']);
  assert.deepEqual(plan.upsert, []);
});

test('a product archived in the back office comes off the registers whole', () => {
  const a = variant('Honey Berry');
  const diff = describeProduct([pair(null, a)], names, NOW);
  assert.equal(diff.kind, 'removed');
  assert.deepEqual(diff.changes, ['Comes off the registers']);
});

test('a stricter age check says it is already enforced; a looser one does not', () => {
  const sent = variant('Honey Berry');
  const stricter = clone(sent);
  stricter.payload.id_scan_required = true;
  assert.deepEqual(describeProduct([pair(stricter, sent)], names, NOW).changes, [
    'Age check 21+ to 21+ with ID scan (already enforced on the registers)',
  ]);
  const looser = clone(sent);
  looser.payload.minimum_age = null;
  assert.deepEqual(describeProduct([pair(looser, sent)], names, NOW).changes, ['Age check 21+ to none']);
});

test('photos changed on every flavor collapse into one line', () => {
  const pairs = ['Honey Berry', 'Rum', 'Original'].map((n, i) => {
    const sent = variant(n, { sort: i, barcode: `07161000010${i}` });
    const live = clone(sent);
    live.payload.image_url = `/api/v1/catalog/images/${i}?size=thumb`;
    return pair(live, sent);
  });
  assert.deepEqual(describeProduct(pairs, names, NOW).changes, ['Photos updated for every flavor']);
});

test('lists read naturally, with no serial comma', () => {
  assert.equal(listNames(['Rum']), 'Rum');
  assert.equal(listNames(['Rum', 'Original']), 'Rum and Original');
  assert.equal(listNames(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 6), 'A, B, C, D, E, F and 2 more');
});

test('an expired price is not a price', () => {
  const live = variant('Honey Berry');
  live.prices[0]!.effective_to = '2026-09-01T00:00:00.000000Z';
  assert.equal(notReadyReason(live, true, NOW), 'Honey Berry needs a price');
});
