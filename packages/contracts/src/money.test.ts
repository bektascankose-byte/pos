import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  money,
  fromMajor,
  toMajorString,
  add,
  subtract,
  sum,
  multiply,
  applyRate,
  allocate,
  allocateByWeight,
  serialize,
  deserialize,
  costToMinor,
  decimal,
  MoneyError,
  ZERO,
} from './money.js';

test('minor units round trip through major-unit strings', () => {
  assert.equal(toMajorString(fromMajor('24.99')), '24.99');
  assert.equal(toMajorString(fromMajor('24.9')), '24.90');
  assert.equal(toMajorString(fromMajor('24')), '24.00');
  assert.equal(toMajorString(fromMajor('0.05')), '0.05');
  assert.equal(toMajorString(fromMajor('-3.50')), '-3.50');
  assert.equal(toMajorString(money('-9223372036854775808')), '-92233720368547758.08');
  assert.equal(fromMajor('24.99'), 2499n);
});

test('dollars passed where cents were expected is refused, not rounded', () => {
  // 24.99 as minor units would be a 100x error. The only safe answer is to stop.
  assert.throws(() => money(24.99), MoneyError);
  assert.throws(() => fromMajor('24.999'), MoneyError);
  assert.throws(() => money('24.99'), MoneyError);
});

test('the classic float failure does not occur', () => {
  // 0.1 + 0.2 !== 0.3 in IEEE-754. This is the whole reason the type exists.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(add(fromMajor('0.10'), fromMajor('0.20')), fromMajor('0.30'));

  // A hundred nickels is exactly five dollars, every time.
  const nickels = Array.from({ length: 100 }, () => fromMajor('0.05'));
  assert.equal(toMajorString(sum(nickels)), '5.00');
});

test('a realistic cart totals to the cent', () => {
  const lines = [multiply(fromMajor('24.99'), 2), fromMajor('6.49'), fromMajor('3.99')];
  const subtotal = sum(lines);
  assert.equal(toMajorString(subtotal), '60.46');

  const promo = fromMajor('-6.49');
  const taxable = add(subtotal, promo);
  const tax = applyRate(taxable, '0.0825');
  assert.equal(toMajorString(tax), '4.45');
  assert.equal(toMajorString(add(taxable, tax)), '58.42');
});

test('tax rounds half up, away from zero', () => {
  // 1000 * 0.0825 = 82.5 exactly. Half up gives 83, banker's rounding gives 82.
  // Two identical receipts must never disagree, so half up it is.
  assert.equal(applyRate(money(1000n), '0.0825'), 83n);
  assert.equal(applyRate(money(-1000n), '0.0825'), -83n);
  assert.equal(applyRate(money(1n), '0.5'), 1n);
  assert.equal(applyRate(money(1n), '0.49'), 0n);
});

test('tax on a rate that binary floating point cannot represent', () => {
  // 0.0825 has no exact float. 8.25 * 100 in JS is 824.9999999999999.
  const amount = fromMajor('8.25');
  assert.equal(amount, 825n);
  assert.equal(applyRate(amount, '0.0825'), 68n);
});

test('allocate never loses or invents a cent', () => {
  const parts = allocate(fromMajor('10.00'), 3);
  assert.deepEqual(parts.map(toMajorString), ['3.34', '3.33', '3.33']);
  assert.equal(sum(parts), fromMajor('10.00'));

  for (const [amount, n] of [
    ['0.01', 3],
    ['99.99', 7],
    ['-10.00', 3],
    ['0.00', 4],
  ] as const) {
    const split = allocate(fromMajor(amount), n);
    assert.equal(split.length, n);
    assert.equal(sum(split), fromMajor(amount), `${amount} across ${n}`);
  }
});

test('weighted allocation sums back exactly, remainder to the largest line', () => {
  // A $5.00 cart discount across lines of 49.98, 6.49 and 3.99.
  const weights = [fromMajor('49.98'), fromMajor('6.49'), fromMajor('3.99')];
  const shares = allocateByWeight(fromMajor('-5.00'), weights);
  assert.equal(sum(shares), fromMajor('-5.00'));
  assert.equal(shares.length, 3);
  // The largest line absorbs the most discount.
  assert.ok(shares[0]! < shares[1]!);
});

test('weights that are all zero fall back to an even split', () => {
  const shares = allocateByWeight(fromMajor('1.00'), [ZERO, ZERO, ZERO]);
  assert.equal(sum(shares), fromMajor('1.00'));
});

test('money crosses the wire as a string, never a number', () => {
  const value = fromMajor('24.99');
  assert.equal(serialize(value), '2499');
  assert.equal(deserialize('2499'), value);

  // JSON.stringify throws on a bigint, which is the behaviour we want: it makes
  // an accidental float round trip impossible rather than merely discouraged.
  assert.throws(() => JSON.stringify({ total: value }), TypeError);

  // Above Number.MAX_SAFE_INTEGER a number would silently lose precision.
  const huge = money('9007199254740993');
  assert.equal(deserialize(serialize(huge)), huge);
  assert.notEqual(Number(serialize(huge)).toString(), serialize(huge));
});

test('cost keeps six decimals until it is posted', () => {
  // A case of 12 at $5.00 is $0.416667 a unit. Rounding that to cents and
  // multiplying back gives 4.92, not 5.00, and margin reports drift from there.
  const unitCost = decimal('0.416667');
  assert.equal(costToMinor(unitCost, 12), 500n);
  assert.equal(toMajorString(costToMinor(unitCost, 12)), '5.00');

  assert.throws(() => decimal('0.4166667'), MoneyError);
});

test('subtraction and negative balances behave', () => {
  assert.equal(toMajorString(subtract(fromMajor('5.00'), fromMajor('7.50'))), '-2.50');
  assert.equal(sum([]), ZERO);
});

test('values outside the Postgres bigint range are rejected', () => {
  assert.throws(() => money('9223372036854775808'), MoneyError);
  assert.throws(() => multiply(money(2n), 999999999999999999999n as unknown as bigint), MoneyError);
});
