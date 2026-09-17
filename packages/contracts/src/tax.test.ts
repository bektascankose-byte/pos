import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money } from './money.js';
import { combineRates, taxForCharge, taxForLine } from './tax.js';

test('rates add exactly, never through a float', () => {
  assert.equal(combineRates(['0.0625', '0.02']), '0.0825');
  assert.equal(combineRates(['0.082500']), '0.0825');
  // 0.1 + 0.2 is the float trap; here it is simply 0.3.
  assert.equal(combineRates(['0.1', '0.2']), '0.3');
  assert.equal(combineRates(['0']), '0');
});

test('a malformed rate is refused rather than guessed at', () => {
  assert.throws(() => combineRates(['8.25%']));
  assert.throws(() => combineRates(['-0.01']));
});

test('one line at the Harker Heights rate matches what the register charges', () => {
  // Two Geek Bars at 24.99: 4998 taxable, 8.25% is 412.335, half up to 412.
  const { tax, snapshot } = taxForLine(money(4998), [{ name: 'TX State + Local Sales Tax', rate: '0.082500' }]);
  assert.equal(tax, 412n);
  assert.deepEqual(snapshot, [{ name: 'TX State + Local Sales Tax', rate: '0.0825', amount_minor: '412' }]);
});

test('split rates are combined before rounding, so they cannot drift a cent from the counter', () => {
  // 10.34 is a value where the two methods disagree. Rounded apart, 6.25% is
  // 64.625 -> 65 and 2% is 20.68 -> 21, which makes 86. The register rounds
  // 8.25% once: 85.305 -> 85. The website has to say 85.
  const apart = [{ name: 'State', rate: '0.0625' }, { name: 'City', rate: '0.02' }];
  assert.equal(taxForLine(money(1034), apart).tax, 85n);
  assert.equal(taxForLine(money(1034), apart).snapshot[0]?.name, 'Sales Tax');
});

test('no rates, or a zero rate, charge nothing and snapshot nothing', () => {
  assert.deepEqual(taxForLine(money(2499), []), { tax: 0n, snapshot: [] });
  assert.deepEqual(taxForLine(money(2499), [{ name: 'Exempt', rate: '0.000000' }]), { tax: 0n, snapshot: [] });
});

test('a delivery fee on an all-taxable order is taxed like one more line at that rate', () => {
  const rate = [{ name: 'TX State + Local Sales Tax', rate: '0.082500' }];
  // $4.99 fee, 8.25%: 41.1675 -> 41.
  const { tax, snapshot } = taxForCharge(money(499), [
    { amount: money(4998), rates: rate },
    { amount: money(1999), rates: rate },
  ]);
  assert.equal(tax, 41n);
  assert.deepEqual(snapshot, [{ name: 'TX State + Local Sales Tax', rate: '0.0825', amount_minor: '41' }]);
});

test('only the share of a fee that follows taxable goods is taxed', () => {
  const rate = [{ name: 'Sales Tax', rate: '0.0825' }];
  // Half the basket untaxed: $5.00 of fee splits 250/250, and only 250 is taxed (20.625 -> 21).
  const { tax } = taxForCharge(money(500), [
    { amount: money(1000), rates: rate },
    { amount: money(1000), rates: [] },
  ]);
  assert.equal(tax, 21n);
});

test('the shares of a fee always add back up to the fee, to the cent', () => {
  const rate = [{ name: 'Sales Tax', rate: '0.10' }];
  // 100 split three ways by equal amounts is 33/33/34: every cent is taxed once, 10% of 100 is 10.
  const { tax } = taxForCharge(money(100), [
    { amount: money(700), rates: rate },
    { amount: money(700), rates: rate },
    { amount: money(700), rates: rate },
  ]);
  assert.equal(tax, 10n);
});

test('no fee, or nothing to spread it over, charges no tax', () => {
  const rate = [{ name: 'Sales Tax', rate: '0.0825' }];
  assert.deepEqual(taxForCharge(money(0), [{ amount: money(1000), rates: rate }]), { tax: 0n, snapshot: [] });
  assert.deepEqual(taxForCharge(money(499), []), { tax: 0n, snapshot: [] });
});
