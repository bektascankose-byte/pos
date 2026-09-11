# Money

## Two representations, deliberately different

| | Type | Used for |
|---|---|---|
| Posted amounts | `bigint` minor units, suffix `_minor` | what a customer was charged, what a report sums, what a drawer holds |
| Catalog costs | `numeric(14,6)` | cost, average cost, last cost |

A case of 12 at $5.00 is a unit cost of $0.416667. Rounding that to cents and
multiplying back gives $4.92, not $5.00, and margin reporting drifts from there
within weeks. So cost keeps six decimals right up until it is posted.

**Rounding happens exactly once per line, at the moment the line is posted, half
up.** The rounded value is what is stored, and nothing downstream re-rounds.

## Never a float

`0.1 + 0.2 !== 0.3`. A cart that sums floats will disagree with the ledger by a
cent often enough to matter and rarely enough to be hard to find.

`Money` is a branded `bigint` with no implicit conversion to `number`, so
`total + 0.1` is a compile error rather than a support ticket six months later.

Rates are decimal strings, not floats: `0.0825` has no exact binary
representation, and tax is the one number nobody forgives being a cent out.
`applyRate()` scales the rate to an integer and does the division in bigint.

## Half up, not banker's rounding

`1000 × 0.0825` is exactly 82.5. Half up gives 83; banker's rounding gives 82.

Banker's rounding is defensible in accounting and wrong here: a customer holding
two identical receipts must not see two different totals.

## Constructing a value

```ts
money(2499n)        // minor units, exact
fromMajor('24.99')  // parses dollars, rejects more precision than a cent
money(24.99)        // throws: whole minor units expected
```

That last one is the important case. `24.99` as minor units would be a 100x
error, so it is refused rather than rounded away.

## On the wire

Money serializes as a digit string of minor units. A JSON number would be
silently lossy above 2^53 and, worse, would invite the client to do float
arithmetic on it. `JSON.stringify` throws on a bigint, which is the behaviour we
want: it makes an accidental float round trip impossible rather than merely
discouraged.

The `moneyMinor` Zod primitive parses that wire format and rejects JSON numbers
outright.

## Allocation

`allocate()` and `allocateByWeight()` guarantee the parts sum back to exactly the
original. Splitting $10.00 three ways gives 334, 333, 333 — not three times 333
with a cent evaporating.

Used by split tender, proportional discount allocation across lines, and tax
distribution. A naive divide silently loses money in all three.

## Where it lives

`packages/contracts/src/money.ts`, with 13 tests in `money.test.ts` covering the
float trap, the tax rounding boundary, allocation exactness, the serialization
round trip above `Number.MAX_SAFE_INTEGER`, and the fractional cost case.
