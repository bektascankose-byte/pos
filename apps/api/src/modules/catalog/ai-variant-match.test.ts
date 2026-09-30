// The AI draft must recognise the item the shop already stocks among the
// flavors it finds, or saving the draft adds a duplicate of it. These are the
// shapes the catalog imported from Modisoft actually has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchUnnamedVariant } from './ai-variant-match.js';

const flavors = (...names: string[]) => names.map((name) => ({ name, existing_variant_id: null as string | null }));
const one = [{ id: 'v1' }];

test('the flavor in the old product name is the item already on the shelf', () => {
  const found = flavors('Orange', 'Kiwi Guava', 'Grapefruit');
  const match = matchUnnamedVariant('Celsius Sparkling Orange 12Oz', found, one, 1);
  assert.equal(match?.flavor.name, 'Orange');
  assert.equal(match?.variantId, 'v1');
});

test('a flavor of several words is matched whole', () => {
  const match = matchUnnamedVariant('Celsius Sparkling Kiwi Guava 12oz', flavors('Orange', 'Kiwi Guava'), one, 1);
  assert.equal(match?.flavor.name, 'Kiwi Guava');
});

test('the longest flavor wins when one is part of another', () => {
  const match = matchUnnamedVariant('Monster Blood Orange 16oz', flavors('Orange', 'Blood Orange'), one, 1);
  assert.equal(match?.flavor.name, 'Blood Orange');
});

test('part of a word is not a match', () => {
  const match = matchUnnamedVariant('Oranges Bulk Bag', flavors('Orange', 'Lime'), one, 1);
  assert.equal(match, null);
});

test('a single item and a single flavor are the same thing', () => {
  const match = matchUnnamedVariant('Zig Zag 1 1/4', flavors('Classic'), one, 1);
  assert.equal(match?.flavor.name, 'Classic');
});

test('nothing is guessed when there is more than one unnamed variant', () => {
  const match = matchUnnamedVariant('Celsius Orange', flavors('Orange'), [{ id: 'a' }, { id: 'b' }], 2);
  assert.equal(match, null);
});

test('the flavor the AI read from the name decides when the name alone does not', () => {
  const found = flavors('Kiwi Guava', 'Orange', 'Grapefruit');
  const match = matchUnnamedVariant('Celsius Sprk Org 12Oz', found, one, 1, 'Orange');
  assert.equal(match?.flavor.name, 'Orange');
});

test('a flavor the AI read that is not among the flavors it found is ignored', () => {
  const match = matchUnnamedVariant('Celsius Sparkling 12oz', flavors('Kiwi Guava', 'Grapefruit'), one, 1, 'Orange');
  assert.equal(match, null);
});

test('a flavor already matched by its own name is left alone', () => {
  const found = [
    { name: 'Orange', existing_variant_id: 'v9' as string | null },
    { name: 'Lime', existing_variant_id: null as string | null },
  ];
  const match = matchUnnamedVariant('Celsius Orange Lime', found, one, 2);
  assert.equal(match?.flavor.name, 'Lime');
});
