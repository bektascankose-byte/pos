// The TypeScript half of the conformance suite.
//
// The Kotlin half is `core-domain/src/test/kotlin/.../PricingConformanceTest.kt`
// and reads **the same JSON files**. That is the entire point: the money
// arithmetic exists twice, once on the server and once on the register, and two
// implementations of the same rules drift. When they drift the symptom is a
// receipt that disagrees with the books by a cent, on some subset of carts, and
// nobody can say which is right.
//
// A fixture is the arbiter. Neither engine is the reference; the JSON is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  money,
  applyRate,
  allocate,
  allocateByWeight,
  costToMinor,
} from '@snappos/contracts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

assert.ok(files.length > 0, 'no fixtures found — the suite must never pass vacuously');

/** Run one case and return its result as strings, or throw. */
function run(operation, c) {
  switch (operation) {
    case 'applyRate':
      return applyRate(money(c.amount), c.rate).toString();

    case 'allocate':
      return allocate(money(c.amount), parseFixtureInteger(c.parts, 'parts')).map(String);

    case 'allocateByWeight':
      return allocateByWeight(money(c.amount), c.weights.map(money)).map(String);

    case 'costToMinor':
      return costToMinor(c.cost, parseFixtureInteger(c.quantity, 'quantity')).toString();

    default:
      throw new Error(`fixture uses an operation the runner does not know: ${operation}`);
  }
}

function parseFixtureInteger(value, field) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`${field} must be an integer encoded as a string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} is outside the fixture runner's safe integer range`);
  }
  return parsed;
}

for (const file of files) {
  const spec = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));

  test(`${spec.operation} (${file})`, async (t) => {
    assert.ok(spec.cases?.length > 0, `${file} has no cases`);

    for (const c of spec.cases) {
      await t.test(c.name, () => {
        if (c.expectError) {
          assert.throws(() => run(spec.operation, c));
          return;
        }
        assert.deepEqual(run(spec.operation, c), c.expect);
      });
    }
  });
}
