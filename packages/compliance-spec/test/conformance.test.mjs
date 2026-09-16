// The TypeScript half of the compliance conformance suite.
//
// The Kotlin half does not exist yet. When the register enforces these rules
// offline it will read **the same JSON files**, for the same reason the pricing
// suite does: the rules will exist twice, and two implementations of the same
// law drift. When they drift the symptom is a register refusing a sale the
// website accepted, or worse, accepting one the website refused.
//
// A fixture is the arbiter. Neither engine is the reference; the JSON is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluateCompliance } from '@snappos/contracts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
assert.ok(files.length > 0, 'no fixtures found — the suite must never pass vacuously');

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));

  test(`${file} — ${fixture.about ?? ''}`.trim(), async (t) => {
    assert.ok(fixture.cases?.length > 0, `${file} has no cases`);

    for (const testCase of fixture.cases) {
      await t.test(testCase.name, () => {
        const decision = evaluateCompliance(testCase.rules, testCase.subject, testCase.context);
        const expected = testCase.expect;

        assert.equal(
          decision.allowed,
          expected.allowed,
          `allowed: ${decision.reason}`,
        );

        // Only assert what a case actually pins. A fixture that names one
        // field is testing that field, and demanding it also predict every
        // other output makes every case brittle for no extra coverage.
        if ('minimumAge' in expected) {
          assert.equal(decision.minimumAge, expected.minimumAge, 'minimumAge');
        }
        if ('requiresIdScan' in expected) {
          assert.equal(decision.requiresIdScan, expected.requiresIdScan, 'requiresIdScan');
        }
        if ('requiresManager' in expected) {
          assert.equal(decision.requiresManager, expected.requiresManager, 'requiresManager');
        }
        if ('requiresProviderVerification' in expected) {
          assert.equal(
            decision.requiresProviderVerification,
            expected.requiresProviderVerification,
            'requiresProviderVerification',
          );
        }
        if ('overridable' in expected) {
          assert.equal(decision.overridable, expected.overridable, 'overridable');
        }
        if ('matchedRuleIds' in expected) {
          assert.deepEqual(
            decision.matchedRuleIds,
            expected.matchedRuleIds,
            'matchedRuleIds — order is part of the contract, not an accident',
          );
        }
        if ('reasonContains' in expected) {
          assert.ok(
            decision.reason.includes(expected.reasonContains),
            `reason ${JSON.stringify(decision.reason)} should contain ${JSON.stringify(expected.reasonContains)}`,
          );
        }

        // A refusal a person cannot act on is a refusal that generates a phone
        // call to the shop.
        if (!decision.allowed) {
          assert.ok(decision.reason.length > 0, 'a denial must say why');
        }
      });
    }
  });
}

test('evaluation does not depend on the order rules arrive in', () => {
  // The database returns rows in whatever order it likes. If that changed the
  // answer, the engine would be deciding law by query plan.
  const rules = [
    { id: 'a', name: 'a', orgId: null, scopeRegion: 'TX', channel: 'pickup', effect: 'allow', priority: 0, effectiveFrom: '2020-01-01T00:00:00Z' },
    { id: 'b', name: 'b', orgId: null, scopeRegion: 'TX', channel: 'pickup', effect: 'require_age', effectAge: 21, priority: 0, effectiveFrom: '2020-01-01T00:00:00Z' },
    { id: 'c', name: 'c', orgId: null, scopeCity: 'Harker Heights', channel: 'pickup', subjectCategoryPathPrefix: 'vapes.', effect: 'require_id_scan', priority: 5, effectiveFrom: '2020-01-01T00:00:00Z' },
  ];
  const subject = { variantId: 'v1', categoryPath: 'vapes.disposable' };
  const context = { channel: 'pickup', region: 'TX', city: 'Harker Heights', asOf: '2026-09-15T12:00:00Z' };

  // All three must actually apply, or this proves nothing about ordering.
  assert.equal(evaluateCompliance(rules, subject, context).matchedRuleIds.length, 3);

  const forwards = evaluateCompliance(rules, subject, context);
  const backwards = evaluateCompliance([...rules].reverse(), subject, context);
  const shuffled = evaluateCompliance([rules[1], rules[2], rules[0]], subject, context);

  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards, shuffled);
});

test('the evaluator is pure — the same inputs answer the same way twice', () => {
  const rules = [
    { id: 'a', name: 'a', orgId: null, scopeRegion: 'TX', channel: 'pickup', effect: 'allow', priority: 0, effectiveFrom: '2020-01-01T00:00:00Z' },
  ];
  const subject = { variantId: 'v1' };
  const context = { channel: 'pickup', region: 'TX', asOf: '2026-09-15T12:00:00Z' };

  assert.deepEqual(
    evaluateCompliance(rules, subject, context),
    evaluateCompliance(rules, subject, context),
  );

  // And it must not mutate what it was given.
  const before = JSON.stringify(rules);
  evaluateCompliance(rules, subject, context);
  assert.equal(JSON.stringify(rules), before, 'the evaluator rewrote its own input');
});
