# Pricing conformance

The money arithmetic exists **twice**: once in TypeScript on the server, once in
Kotlin on the register. That duplication is deliberate — a register has to price
a cart with the network unplugged — and it is the project's [number one
technical risk](../../docs/ARCHITECTURE.md). Two implementations of the same
rules drift, and when they do the symptom is a receipt that disagrees with the
books by a cent on some subset of carts, with no way to say which side is right.

These fixtures are the mitigation. Section B of the architecture calls them
"not optional".

## How it works

`fixtures/*.json` describe cases in a language neutral way. Two runners read the
same files:

| Engine | Runner |
|---|---|
| TypeScript | `test/conformance.test.mjs` — `npm test -w @snappos/pricing-spec` |
| Kotlin | `core-domain/.../PricingConformanceTest.kt` — `./gradlew :core-domain:test` |

Both run in CI on every commit, in the `Pricing conformance (both engines)` job.

**Neither engine is the reference. The JSON is.** When they disagree, the
fixture says which is right — and if the fixture is wrong, it is changed
deliberately and both engines follow.

## Writing a case

```json
{
  "name": "exactly half rounds up, not to even",
  "about": "why this case matters, if it is not obvious",
  "amount": "50",
  "rate": "0.05",
  "expect": "3"
}
```

Every value is carried as a **string**, including quantities and counts. A
fixture that used a JSON number would depend on how each language parses it,
which is precisely the class of difference the suite exists to catch.

`"expectError": true` asserts the operation is refused rather than producing a
wrong answer quietly.

## Operations covered

- `applyRate` — tax and percentage discounts, half up away from zero
- `allocate` — split into n parts that sum back exactly
- `allocateByWeight` — proportional split, remainder to the largest weights
- `costToMinor` — post a `numeric(14,6)` cost to minor units, rounding once

Cart level cases will be added when a TypeScript pricing engine exists; today
the server receives computed totals from the register and checks the variance,
so the shared surface is the primitives above.

## When a pricing bug is found

Add the case that would have caught it, then fix the engines. A bug that reaches
production and leaves no fixture behind is one that can come back.

## Proving the suite can fail

A conformance suite that cannot fail is worse than none, because it reports
safety it is not providing. This one was validated by mutation: removing the
half-up rounding from the Kotlin `divideRoundHalfUp` produced

```
apply-rate.json: exactly half rounds up, not to even expected:<3> but was:<2>
```

naming the fixture and the case. Worth repeating after any change to the runner.
