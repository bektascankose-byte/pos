import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointsForBasis, pointsValueMinor } from './loyalty.js';

test('a point for each whole dollar spent, never one for a dollar not spent', () => {
  assert.equal(pointsForBasis(3998n, '1.00'), 39);
  assert.equal(pointsForBasis(100n, '1'), 1);
  assert.equal(pointsForBasis(99n, '1'), 0);
});

test('rates with cents are exact, and nothing is earned on nothing', () => {
  // $19.99 at 1.5 points a dollar is 29.985, rounded down to 29.
  assert.equal(pointsForBasis(1999n, '1.5'), 29);
  assert.equal(pointsForBasis(1000n, '2.25'), 22);
  assert.equal(pointsForBasis(0n, '1'), 0);
  assert.equal(pointsForBasis(-500n, '1'), 0);
});

test('what points are worth when spent, rounded down to the cent', () => {
  assert.equal(pointsValueMinor(250, '100'), 250n);
  assert.equal(pointsValueMinor(39, '100'), 39n);
  assert.equal(pointsValueMinor(1, '3'), 33n);
  assert.equal(pointsValueMinor(0, '100'), 0n);
});

test('a rate that is not a two-decimal number is refused', () => {
  assert.throws(() => pointsForBasis(100n, '1.005'));
  assert.throws(() => pointsForBasis(100n, '-1'));
});
