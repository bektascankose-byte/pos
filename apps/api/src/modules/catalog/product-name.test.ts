// Every case here is a real string out of the Modisoft item file, not an
// invented one. The point of this pass is that 8,646 names go through it
// once, unsupervised, so the cases that matter are the ones that actually
// occur -- and the ones it must LEAVE ALONE matter as much as the ones it
// changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanProductName } from './product-name.js';
import { normalizeCode } from './scan-code.js';

const name = (input: string) => cleanProductName(input).name;

test('whitespace is collapsed and trimmed', () => {
  assert.equal(name('cloud nurdz strawberry mango 25mg '), 'Cloud Nurdz Strawberry Mango 25mg');
  assert.equal(name('Zen 3 Bundles Pipe Cleaners  Soft  132 Count'), 'Zen 3 Bundles Pipe Cleaners Soft 132 Count');
  assert.equal(name('pall mall 100 bx fsc     1'), 'Pall Mall 100 Bx Fsc 1');
});

test('UTF-8 read as Latin-1 is repaired', () => {
  assert.equal(
    name('Zig-ZagÂ® Ultra Thin Rolling Papers 1 1/4-6 Packs'),
    'Zig-Zag® Ultra Thin Rolling Papers 1 1/4-6 Packs',
  );
});

test('a name that is entirely lower case is title cased', () => {
  assert.equal(name('rapture kraitom cherry float'), 'Rapture Kraitom Cherry Float');
  assert.equal(name('zig zag 3 pack king size'), 'Zig Zag 3 Pack King Size');
});

test('a name that is entirely upper case is title cased -- shouting carries no information', () => {
  assert.equal(name('HAWAIIAN BREEZE'), 'Hawaiian Breeze');
  assert.equal(name('COHIBA ROBUSTO'), 'Cohiba Robusto');
});

test("deliberate capitals inside a mixed-case name are somebody's, and survive", () => {
  // The rule is per word, not per name: "SS" is Swisher Sweets and stays,
  // while the lowercase half of the same string still gets tidied.
  assert.equal(name('SS Banana Smash  2pk $1.29pp'), 'SS Banana Smash 2pk $1.29pp');
  assert.equal(name('Marlboro blk sp blend 100 '), 'Marlboro Blk Sp Blend 100');
  assert.equal(name('White Owl  choc & vanil'), 'White Owl Choc & Vanil');
});

test('an apostrophe is not a word boundary', () => {
  // The bug this guards: "100's" coming back as "100'S".
  assert.equal(name("montego blue 100's"), "Montego Blue 100's");
});

test('units are regularised even inside a name whose capitals are otherwise left alone', () => {
  assert.equal(name('Cloud Nurdz Strawberry Mango 6MG/100ML'), 'Cloud Nurdz Strawberry Mango 6mg/100ml');
  assert.equal(name('Space Mary Miami mint 8k Pfs Disp.'), 'Space Mary Miami Mint 8K Pfs Disp.');
});

test('a hyphen is a word boundary', () => {
  assert.equal(name('twist e-liquid salt nicotine 2x30ml'), 'Twist E-Liquid Salt Nicotine 2x30ml');
});

test('known acronyms keep their shape', () => {
  assert.equal(name('thc gummies 10mg'), 'THC Gummies 10mg');
  assert.equal(name('SPINNY SYRINGE (ASIAN PEAR + SKYWALKER OG'), 'Spinny Syringe (Asian Pear + Skywalker OG');
});

test('misspellings and meaningless names are left exactly as they are', () => {
  // Deliberate. A rule that "fixed" these would also rewrite real brand
  // names, and inventing a name is worse than flagging a bad one.
  assert.equal(name('bule kush cake hybird'), 'Bule Kush Cake Hybird');
  assert.equal(name('zburst'), 'Zburst');
});

test('names nothing can be made of are flagged rather than invented', () => {
  assert.deepEqual(cleanProductName(''), { name: '', unusable: true });
  assert.deepEqual(cleanProductName('   '), { name: '', unusable: true });
  // A barcode pasted into the name column: kept verbatim, not prettified, and
  // flagged -- the row is still worth having for its price and department.
  assert.deepEqual(cleanProductName('765066188603'), { name: '765066188603', unusable: true });
  assert.equal(cleanProductName('pod').unusable, true);
  assert.equal(cleanProductName('Donut Rolls').unusable, false);
});

test('cleaning is idempotent -- a second import must not keep changing names', () => {
  const samples = [
    'Zig-ZagÂ® Ultra Thin Rolling Papers 1 1/4-6 Packs',
    "montego blue 100's",
    'SS Banana Smash  2pk $1.29pp',
    'HAWAIIAN BREEZE',
    'Cloud Nurdz Strawberry Mango 6MG/100ML',
  ];
  for (const sample of samples) {
    const once = name(sample);
    assert.equal(name(once), once, `not stable: ${sample}`);
  }
});

test('scan codes drop symbology and stray keystrokes, but never real internal codes', () => {
  assert.equal(normalizeCode('*796817654114*'), '796817654114');
  assert.equal(normalizeCode('  850058810676  '), '850058810676');
  // A slipped finger in front of a UPC-A. Confirmed against the source file:
  // each of these collides with a row that already exists without it.
  assert.equal(normalizeCode('+850058810676'), '850058810676');
  assert.equal(normalizeCode('.795847774565'), '795847774565');
  assert.equal(normalizeCode('\\011000000006'), '011000000006');
  // Somebody's real internal codes. Stripping anything here would lose them.
  assert.equal(normalizeCode('42030-43'), '42030-43');
  assert.equal(normalizeCode('B4SLOT'), 'B4SLOT');
  assert.equal(normalizeCode('12345PPPPP'), '12345PPPPP');
});
