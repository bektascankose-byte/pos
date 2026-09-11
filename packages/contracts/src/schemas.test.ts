import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProductSchema, scanSchema } from './catalog.js';
import { postMovementSchema } from './inventory.js';
import { syncEnvelopeSchema, changesQuerySchema } from './sync.js';
import { moneyMinor, uuidV7 } from './primitives.js';

const V7 = '018f3a2b-7c1d-7abc-8def-0123456789ab';
const V4 = '9f1b4c2e-5a3d-4b6e-8c7f-1234567890ab';

test('a UUIDv4 is refused where a v7 is required', () => {
  // Not pedantry: v4 ids destroy the index locality the schema is built on, and
  // a v4 here means something generated the id with the wrong function.
  assert.ok(uuidV7.safeParse(V7).success);
  assert.ok(!uuidV7.safeParse(V4).success);
});

test('money arrives as a digit string and never as a JSON number', () => {
  assert.equal(moneyMinor.parse('2499'), 2499n);
  assert.equal(moneyMinor.parse('-500'), -500n);
  assert.ok(!moneyMinor.safeParse(2499).success, 'a JSON number must be refused');
  assert.ok(!moneyMinor.safeParse('24.99').success, 'major units must be refused');
});

test('a product must have at least one variant', () => {
  const result = createProductSchema.safeParse({ name: 'Anything', variants: [] });
  assert.ok(!result.success);
});

test('a single variant product needs no axes, a multi variant one does', () => {
  const single = createProductSchema.safeParse({
    name: 'Monster Energy Ultra',
    variants: [{ sku: 'MON-ULTRA-16' }],
  });
  assert.ok(single.success, single.success ? '' : JSON.stringify(single.error.issues));

  const multiNoAxes = createProductSchema.safeParse({
    name: 'Geek Bar Pulse X',
    variants: [{ sku: 'GB-MM' }, { sku: 'GB-BR' }],
  });
  assert.ok(!multiNoAxes.success, 'several variants with no declared axis must be refused');

  const multi = createProductSchema.safeParse({
    name: 'Geek Bar Pulse X',
    variant_axes: ['flavor'],
    variants: [
      { sku: 'GB-MM', variant_name: 'Miami Mint', attributes: { flavor: 'Miami Mint' } },
      { sku: 'GB-BR', variant_name: 'Blue Razz', attributes: { flavor: 'Blue Razz' } },
    ],
  });
  assert.ok(multi.success);
});

test('duplicate SKUs within one product are refused', () => {
  const result = createProductSchema.safeParse({
    name: 'Duplicated',
    variant_axes: ['flavor'],
    variants: [{ sku: 'SAME' }, { sku: 'SAME' }],
  });
  assert.ok(!result.success);
});

test('a barcode keeps its leading zeros', () => {
  const parsed = scanSchema.parse({ barcode: '00012345', store_id: V4 });
  assert.equal(parsed.barcode, '00012345');
});

test('a zero stock movement is refused', () => {
  const base = { store_id: V4, variant_id: V4, reason: 'receiving' as const };
  assert.ok(postMovementSchema.safeParse({ ...base, delta: '5' }).success);
  assert.ok(postMovementSchema.safeParse({ ...base, delta: '-5' }).success);
  assert.ok(!postMovementSchema.safeParse({ ...base, delta: '0' }).success);
  assert.ok(!postMovementSchema.safeParse({ ...base, delta: '0.000' }).success);
});

test('shrinkage reasons require a note', () => {
  const base = { store_id: V4, variant_id: V4, delta: '-2' };
  assert.ok(!postMovementSchema.safeParse({ ...base, reason: 'theft' }).success);
  assert.ok(postMovementSchema.safeParse({ ...base, reason: 'theft', note: 'shelf sweep' }).success);
  // Receiving does not, because the purchase order is the explanation.
  assert.ok(postMovementSchema.safeParse({ ...base, delta: '10', reason: 'receiving' }).success);
});

test('a movement reason only the system may post is not accepted from a client', () => {
  const base = { store_id: V4, variant_id: V4, delta: '-1' };
  // 'sale' is posted as a consequence of a sale existing. Allowing it here
  // would create stock movement with no sale behind it.
  assert.ok(!postMovementSchema.safeParse({ ...base, reason: 'sale' }).success);
});

test('a sync envelope carries the entity id as its own idempotency key', () => {
  const ok = syncEnvelopeSchema.safeParse({
    id: V7,
    entity_type: 'sale',
    device_time: '2026-09-11T14:32:00.000-05:00',
    payload: { total_minor: '5842' },
  });
  assert.ok(ok.success);
  assert.equal(ok.success && ok.data.attempt, 0);

  const naiveTime = syncEnvelopeSchema.safeParse({
    id: V7,
    entity_type: 'sale',
    device_time: '2026-09-11T14:32:00',
    payload: {},
  });
  assert.ok(!naiveTime.success, 'a timestamp with no offset is ambiguous and must be refused');
});

test('the change cursor is a string, because a bigserial outgrows a JSON number', () => {
  const parsed = changesQuerySchema.parse({ since: '9007199254740993', scopes: 'catalog,prices' });
  assert.equal(parsed.since, '9007199254740993');
  assert.deepEqual(parsed.scopes, ['catalog', 'prices']);
  assert.equal(parsed.limit, 500);

  assert.ok(!changesQuerySchema.safeParse({ scopes: 'catalog,nonsense' }).success);
});
