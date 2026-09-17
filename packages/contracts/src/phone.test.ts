import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsPhone, normalizeUsPhone, phoneHint } from './phone.js';

test('every way a person types the same US number finds the same record', () => {
  for (const typed of ['(254) 555-0123', '254-555-0123', '254.555.0123', '2545550123', '1 254 555 0123', '+1 254 555 0123', ' +12545550123 ']) {
    assert.equal(normalizeUsPhone(typed), '+12545550123', typed);
  }
});

test('numbers that cannot be real US numbers are refused, not guessed at', () => {
  for (const typed of ['', '555-0123', '154 555 0123', '254 155 0123', '+44 20 7946 0958', '254-555-01234', 'call me', '254 555 0123 ext 4']) {
    assert.equal(normalizeUsPhone(typed), null, typed);
  }
});

test('a stored number reads back the way people write it, and a hint shows only the last four digits', () => {
  assert.equal(formatUsPhone('+12545550123'), '(254) 555-0123');
  assert.equal(formatUsPhone('+442079460958'), '+442079460958');
  assert.equal(phoneHint('+12545550123'), 'ending in 0123');
});
