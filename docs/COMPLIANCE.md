# Compliance

> This document describes how the software is built. It is not legal advice.
> The rules governing these product categories change frequently and vary by
> state, county and city. Have counsel review before the first regulated SKU is
> sold through this system, and again before anything is listed online or
> delivered.

## The design principle

**Rules are data with effective dates. The engine fails closed.**

Not a preference. Texas hemp rules changed three times in twelve months, and the
federal hemp redefinition in H.R. 5371 takes effect 2026-11-12. Software that
encodes today's rules in today's code needs a deploy every time a legislature
moves, and a deploy is exactly what is not available on the day a rule changes.

So `compliance_rules` rows carry `effective_from` and `effective_to`. A rule
change is a row, not a release. History is preserved, which matters when someone
asks what the rule was on the day of a particular sale.

**Fail closed** means: if eligibility cannot be established, the transaction is
not allowed. An unknown product, a missing rule, an unreachable verification
provider — all produce refusal, never a default permit. The expensive failure
here is selling something you should not have, not declining a sale you could
have made.

## In-store verification

At the counter the register prompts when the product requires it. A driver's
licence barcode (PDF417) is parsed **on the device**.

What is stored is only this:

- that a verification happened
- when
- which employee
- by what method (scan or manual)
- the outcome

**No ID images. No licence numbers. No date of birth. No name.**

The schema enforces it: `age_verifications` has nowhere to put identity data. An
invariant test asserts that, because the only reliable way to guarantee data is
not collected is to have nowhere to put it. A breach cannot leak what was never
stored, and a subpoena cannot compel what does not exist.

If a jurisdiction later requires retaining more, that becomes a deliberate,
reviewed migration with its own encryption and retention policy — not a field
somebody adds quietly.

## Product level rules

`product_compliance` carries, per product:

| Field | Purpose |
|---|---|
| `minimum_age` | The statutory age |
| `id_scan_required` | Whether visual judgement is permitted |
| `regulated_class` | `ends`, `cigar`, `pouch`, and so on |
| `contains_nicotine` | |
| `contains_cannabinoid` | |
| `is_smokable` | Separately regulated from other forms in Texas |

Compliance lives on the product rather than the variant because every flavor of a
disposable carries the same statutory age.

Channel flags determine whether a SKU may be listed online, added to a cart, paid
for, scheduled for delivery, or handed over — each is a separate decision, because
a product can be legal to sell in the shop, legal to reserve for pickup, and
prohibited for delivery, all at once.

## Jurisdiction

Rules vary by country, state, county and city, and `stores` carries `region`,
`county` and `city` for exactly that reason. County is not decoration: several
regulated product rules in Texas are county level.

A rule can also vary by delivery provider and by payment provider. A carrier that
will not move nicotine makes a product undeliverable regardless of what the law
says, and the system has to know that at checkout rather than at dispatch.

## The categories this shop carries

Flagged because they are the ones most likely to have moved since this was
written:

- **Smokable hemp flower and pre-rolls** — left legal Texas retail 2026-03-31
- **Delta-8, delta-10, THCP** — scheduled 2026-07-31
- **Federal hemp redefinition (H.R. 5371)** — effective 2026-11-12

**Confirm all of it with your attorney.** The software's job is to make you fast
to respond to a change, not to know what the change is.

## Delivery

ATF treats a remote ENDS order as a delivery sale whether it ships by carrier or
goes out in your own vehicle. PACT Act obligations and the Texas e-cigarette
retailer permit's delivery language both need counsel's read before a single order
is dispatched.

Uber Direct prohibits nicotine outright. DoorDash excludes it from the marketplace
and permits Dasher delivery only under a negotiated tobacco-specific agreement.
The first realistic delivery provider is your own driver — and even that needs the
legal review above first.

## Marketing consent

`customer_consents` records the consent, its timestamp and its source. STOP
handling and suppression lists are mandatory. A message to someone who opted out
is a legal problem, not a bug.

## What exists today

| | State |
|---|---|
| `product_compliance` table and columns | **Built** |
| `compliance_rules`, effective dated | **Built** |
| `age_verifications`, metadata only | **Built**, with an invariant test |
| Compliance data returned on the scan path | **Built** — one call returns price, stock and the age rule |
| Rule evaluation engine | **Phase 2** |
| On device ID scan | **Phase 2** |
| Online age gate and verification provider | **Phase 6** |
| Compliance rule editor in the dashboard | **Phase 6** |

The register's scan response already carries `minimum_age` and `id_scan_required`,
because the prompt has to be decidable before the line renders. Deciding it after
would mean a cashier could add a restricted item to a cart without being asked.
