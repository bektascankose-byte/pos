# Integrations

Status of every external dependency, using four honest states. Nothing here is
described as working because an interface exists for it.

| State | Means |
|---|---|
| **Implemented** | Written, tested, running |
| **Sandbox tested** | Works against the provider's test environment |
| **Needs credentials** | Code is ready; requires an account we do not have |
| **Needs approval** | Requires underwriting, a negotiated agreement, or legal review |
| **Not started** | Interface not yet defined |

## Payments

| Provider | State | Notes |
|---|---|---|
| Any | **Not started** | `PaymentProvider` interface is Phase 3 |

**Stripe, Square and PayPal all prohibit vape and nicotine.** This is a
contractual prohibition, not a technical limitation, and no amount of engineering
routes around it.

What is needed is a high risk merchant account underwritten for **MCC 5993**
behind a gateway — NMI, Authorize.Net, USAePay or PayTrace. Underwriting takes
days to weeks, requires permits and licenses, and can be withdrawn later if
chargebacks spike.

**Start this now.** Phase 3 cannot be tested without sandbox access, and sandbox
access generally follows approval. This is the longest lead time item in the
project and it is not engineering work.

Whatever is chosen, the integration is **semi integrated P2PE**: the terminal
handles the card and returns a token. No card data enters this system, ever.

## Delivery

| Provider | State | Notes |
|---|---|---|
| Own driver | **Not started** | Phase 6. The only realistic first provider |
| Uber Direct | **Needs approval** | Prohibits nicotine outright |
| DoorDash Drive | **Needs approval** | Excluded from marketplace; Dasher delivery only under a negotiated tobacco agreement, not self serve |

The engineering here is straightforward; the permission is not. Before a single
order is dispatched, counsel needs to read on PACT Act delivery sale obligations
and the Texas e-cigarette retailer permit's delivery language. ATF treats a remote
ENDS order as a delivery sale whether it goes by carrier or by your own vehicle.

`DeliveryProvider` must check product eligibility per provider, not just per
order. A provider that will carry a bottle of soda will not carry the vape next to
it, and the system has to know that before it offers delivery at checkout.

## Age verification

| Provider | State | Notes |
|---|---|---|
| On device ID scan (PDF417) | **Not started** | Phase 2. Parsed locally on the register |
| Online verification provider | **Not started** | Phase 6 |

In store, the driver's licence barcode is parsed **on the register** and the
result is not retained. Only verification metadata is stored: that a check
happened, when, by whom, by what method, and the outcome. **No ID images, no
licence numbers, no date of birth.**

The schema enforces this — there is nowhere to put the identity data, which is
the only reliable way to guarantee it is not collected.

## Tax

| Provider | State | Notes |
|---|---|---|
| Built in rate tables | **Implemented** | Effective dated rows per store and category |
| External tax service | **Not started** | `TaxProvider` interface, Phase 4+ |

Rates are never a hard coded percentage. `tax_rates` is effective dated so a rate
change does not rewrite history.

The seeded 8.25% is a development value, not tax advice. Real rates are configured
per store before go live.

## SMS and email

| Provider | State | Notes |
|---|---|---|
| Twilio / others | **Not started** | Phase 7 |

Consent is not a feature to add later: `customer_consents` records the consent,
its timestamp and its source. STOP handling and suppression lists are mandatory,
not optional, and a message to someone who opted out is a legal problem rather
than a bug.

## EDI

| Provider | State | Notes |
|---|---|---|
| X12 over SFTP/AS2 | **Not started** | Phase 8 |
| Invoice ingestion | **Not started** | Phase 8, and the realistic first version |

The brief assumes vendors have EDI. **Most smoke shop distributors do not.** Many
send a PDF invoice by email, some have a web portal, a few have an API, and a very
small number do true X12.

So the realistic Phase 8 is an invoice ingestion pipeline — email intake, PDF and
CSV parsing, line matching against the purchase order, human confirmation — with
an X12 adapter for the two or three vendors that support it. Planning pure X12 is
planning for a world that is not yours. Trading partner testing takes weeks per
vendor regardless.

## Hardware

| Device | State | Notes |
|---|---|---|
| ESC/POS receipt printers | **Not started** | Phase 2 |
| Cash drawer (via printer kick) | **Not started** | Phase 2 |
| HID barcode scanners | **Not started** | Phase 2 |
| Customer display | **Not started** | Phase 5 |
| Label printers | **Not started** | Phase 4 |

`hardware-api` holds interfaces only. **Nothing in checkout imports a hardware
adapter** — a printer that is out of paper must never be able to stop a sale from
completing.

## Object storage

| Provider | State | Notes |
|---|---|---|
| MinIO (development) | **Implemented** | Running in the dev stack |
| Cloudflare R2 (production) | **Needs credentials** | Same S3 API; swap an endpoint |

## Infrastructure in the dev stack

| Service | State |
|---|---|
| PostgreSQL 16 | **Implemented** |
| Redis 7 | **Implemented** (running; no queues consume it yet) |
| MinIO | **Implemented** (running; nothing uploads yet) |
| Toxiproxy | **Implemented** (running; the sync fault harness that uses it is Phase 2) |

## Modisoft migration

| | State |
|---|---|
| Export mapping | **Not started** — Phase 4 |

**Pull a full export now and keep pulling one monthly.** The mapping is Phase 4
work, but a real file to build against is worth having months early, and a year of
sales history is what validates forecasting later.
