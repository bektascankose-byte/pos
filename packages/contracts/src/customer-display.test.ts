import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  customerDisplayBirthdaySchema,
  customerDisplayIdentifySchema,
  customerDisplayOffersSchema,
  daysInBirthMonth,
  isRealBirthday,
} from './customer-display.js';

test('a leap day is a real birthday, because a birthday has no year', () => {
  assert.equal(daysInBirthMonth(2), 29);
  assert.equal(isRealBirthday(2, 29), true);
  assert.equal(isRealBirthday(2, 30), false);
});

test('thirty day months stop at thirty', () => {
  for (const month of [4, 6, 9, 11]) {
    assert.equal(isRealBirthday(month, 30), true);
    assert.equal(isRealBirthday(month, 31), false);
  }
  for (const month of [1, 3, 5, 7, 8, 10, 12]) assert.equal(isRealBirthday(month, 31), true);
});

test('months and days that do not exist are refused', () => {
  assert.equal(daysInBirthMonth(0), 0);
  assert.equal(daysInBirthMonth(13), 0);
  assert.equal(isRealBirthday(13, 1), false);
  assert.equal(isRealBirthday(5, 0), false);
  assert.equal(isRealBirthday(5, 1.5), false);
});

test('the birthday schema refuses a day the month does not have', () => {
  assert.equal(customerDisplayBirthdaySchema.safeParse({ birth_month: 4, birth_day: 31 }).success, false);
  assert.equal(customerDisplayBirthdaySchema.safeParse({ birth_month: 4, birth_day: 30 }).success, true);
});

test('a lookup takes a phone or an email, one of the two', () => {
  assert.equal(customerDisplayIdentifySchema.safeParse({ phone: '+12545550137' }).success, true);
  assert.equal(customerDisplayIdentifySchema.safeParse({ email: 'Maria@Example.com' }).success, true);
  assert.equal(customerDisplayIdentifySchema.safeParse({}).success, false);
  assert.equal(
    customerDisplayIdentifySchema.safeParse({ phone: '+12545550137', email: 'maria@example.com' }).success,
    false,
  );
  // Ten bare digits are not what the customer table holds.
  assert.equal(customerDisplayIdentifySchema.safeParse({ phone: '2545550137' }).success, false);
});

test('an email is lowercased on the way in, so the lookup is exact', () => {
  const parsed = customerDisplayIdentifySchema.parse({ email: 'Maria@Example.com' });
  assert.equal(parsed.email, 'maria@example.com');
});

test('an answer about offers has to say what was asked', () => {
  assert.equal(
    customerDisplayOffersSchema.safeParse({ channel: 'sms', granted: true, wording: '  ' }).success,
    false,
  );
  assert.equal(
    customerDisplayOffersSchema.safeParse({ channel: 'sms', granted: false, wording: 'Want deals by text?' })
      .success,
    true,
  );
});
