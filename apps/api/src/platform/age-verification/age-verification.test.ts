import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOn } from './age-verification.service.js';

test('someone is 21 on their 21st birthday and not the day before', () => {
  assert.equal(ageOn('2005-09-17', '2026-09-17'), 21);
  assert.equal(ageOn('2005-09-18', '2026-09-17'), 20);
  assert.equal(ageOn('2005-10-01', '2026-09-17'), 20);
});

test('a leap-day birthday turns over on the first of March in other years', () => {
  assert.equal(ageOn('2004-02-29', '2025-02-28'), 20);
  assert.equal(ageOn('2004-02-29', '2025-03-01'), 21);
});

test('dates that do not exist, or have not happened yet, have no age', () => {
  assert.equal(ageOn('2001-02-30', '2026-09-17'), null);
  assert.equal(ageOn('2030-01-01', '2026-09-17'), null);
  assert.equal(ageOn('17/09/2005', '2026-09-17'), null);
});
