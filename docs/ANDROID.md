# Android register

Kotlin, Jetpack Compose, multi-module Gradle.

## Status

| Module | State |
|---|---|
| `core-domain` | **Money, cart and UUIDv7 built, 37 tests passing.** Pure Kotlin, no Android. |
| `app` | **Selling on hardware.** Unlock, drawer, scan to cart, the 21+ gate, cash tender, refunds with manager approval. |
| `core-data` | **Built.** Room over SQLCipher, 16 tables, schema v2, migration 1-2 exercised on a device holding v1 data. |
| `core-sync` | **Built.** Retrofit client, outbox drain, catalog pull, WorkManager. |
| `hardware/hardware-api` | **`PrinterProvider` defined.** Interfaces only — no vendor SDK, no Android dependency. |

`./gradlew :app:assembleDebug` produces a debug APK. `./gradlew test` runs the
JVM suites.

## Toolchain

Pinned, and the pinning is load bearing:

| | Version | Notes |
|---|---|---|
| JDK | 17 | AGP 8.x requires it |
| Gradle | 8.13 | See below |
| AGP | 8.13.0 | |
| Kotlin | 2.1.0 | |
| compileSdk / targetSdk | 36 | See below |
| minSdk | 26 | Android 8. Covers every current POS terminal |

**Gradle 9.6 does not work with AGP 8.13.** AGP relies on
`org.gradle.api.problems.internal.InternalProblems`, which Gradle removed in
9.6, and the build fails at plugin application with a message naming that API.
AGP 9.0 resolves but then collides with the Kotlin Android plugin, because AGP 9
registers a `kotlin` extension of its own. Gradle 8.13 with AGP 8.13 is the
combination that works; do not bump one without the other.

**compileSdk is 36, not 37**, even though this machine has API 37 installed. AGP
8.13 predates API 37 and warns that it cannot support it, and the installed
platform directory is named `android-37.0` while AGP looks for `android-37`, so
resolution fails outright. 36 matches the installed build-tools.

## Setup

Copy `local.properties.example` to `local.properties` (gitignored) and point it
at the SDK. Use forward slashes on Windows: Java properties files treat `\U` as
an escape, so a backslash path silently mangles into something unusable.

```
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

## Module rules

**`core-domain` may not import anything from `android.*`.** The pricing engine
and cart model live there, they run as plain JVM tests in milliseconds, and the
pricing conformance suite has to be cheap enough to run on every commit. One
Android import would drag the whole suite onto an emulator.

**Nothing in checkout imports a hardware adapter — only `hardware-api`.** A
printer out of paper, an unplugged drawer, or a vendor SDK that changes next year
must never be able to stop a sale from completing, and the only reliable
guarantee is that the sale path has no way to name a concrete device.

## Money runs twice

`core-domain/Money.kt` is the Kotlin half of a type that also exists in
TypeScript at `packages/contracts/src/money.ts`. The register computes a total
offline and the server recomputes it later; if the two disagree, a customer was
charged something the reports do not recognise.

`MoneyTest.kt` mirrors `money.test.ts` case for case, deliberately. Both are at
13 tests and both pass. **If a case changes in one, change it in the other in the
same commit.**

That mirroring is the cheap half of the defence. The other half — a language
neutral fixture suite in `packages/pricing-spec` that both engines run in CI — is
Phase 2 work and is not optional. Section B of the architecture is explicit that
if the conformance suite is ever allowed to be skipped, engine drift becomes the
project's number one technical risk.

Both implementations agree on the decisions that matter:

- minor units in a 64 bit integer, never a float
- rates as decimal strings, scaled to integers before dividing
- half up rounding, away from zero, once per line at post time
- allocation that sums back to exactly the original
- overflow throws rather than wrapping

## Design tokens

From architecture section O, in `ui/Theme.kt`.

Dark by default. Not a stylistic preference: a bright screen behind a counter for
a ten hour shift is fatiguing, and a dark surface makes the cart the brightest
thing in the room, which is where the cashier's eyes belong. Light mode is a per
device setting.

Touch targets are 56dp minimum and 72dp for PAY and the tender buttons.

**Tabular numerals on every money figure.** Money in a proportional font is the
single most common way a retail interface looks cheap: price columns fail to
align and a changing total shimmers as digits change width.

**Zero animation on the scan-to-cart path.** A row that animates in is a row the
cashier waits for. The budget is 120ms from HID input to rendered row, and
animation spends it.

The sync pill shows Online, Syncing, Offline or Sync Error. **Offline is amber,
not red.** Offline is a normal, safe operating mode — the sale is being saved on
this device — and the interface must not communicate panic about it. Red is for a
sync error, the only state that actually needs a person.

## Running it

The APK builds but has not been run on a device yet: no emulator image is
installed. Either create an AVD, or connect a phone or tablet with USB debugging
and:

```bash
cd apps/pos-android
./gradlew installDebug
```

A physical device is the better test of the two — real touch targets, real
scanner hardware — though the layout is designed for a landscape terminal and
will be cramped on a handset.

## Reaching the server from a device

`adb reverse tcp:3000 tcp:3000` tunnels the phone's `localhost:3000` to the
development machine over USB. Chosen over the machine's LAN address because it
survives a VPN, a firewall and a change of wifi — none of which anyone should
have to debug in order to ring a test sale.

```bash
adb reverse tcp:3000 tcp:3000
```

Note that removing the tunnel does **not** simulate being offline: OkHttp keeps
pooled connections alive and requests keep succeeding for a while. Stop the API
process instead.

## What is proven on hardware

Verified on a Galaxy S22 Ultra against the real API:

- sign in, adopt the store and register identity, pull a 12 variant catalog
- scan to cart, per line tax from the server's own rate
- the 21+ gate blocking payment until ID is confirmed
- a sale committed locally and uploaded: stock deducted through the ledger
- **two sales rung with the API process stopped**, both draining when it
  returned, each landing exactly once, with the levels still equal to the sum
  of the ledger
- a full shift: unlock as a cashier, open a drawer with a $200 float, ring a
  cash sale, a cashier refused permission to close, a manager unlocking and
  closing on a blind count that reported **short 2.03 against an expected
  207.03** — and the session, its movements and the close all reaching the
  server
- **a partial refund against a receipt**: one of two units returned, the
  cashier's own PIN refused, a manager's accepted, the refund uploading under
  the cashier's token and restocking server side (18 back to 19) with
  `approved_by` naming the manager and `inventory_levels` still equal to
  `sum(inventory_ledger.delta)` on every variant
- **the Room 1 to 2 migration** run against a device that already held v1 data,
  opening with its roster and sales intact
- **the refund guard at its boundary**: the second unit of the same receipt
  refunded on a later day's session, taking that sale to fully refunded, after
  which looking the receipt up again is refused with "everything on HH01-R1-3
  has already been refunded" — before the cashier can promise the customer
  anything
- **a void taken at the counter**: the sale rung and uploaded, the cashier's own
  PIN refused with "that PIN cannot void a sale", a manager's accepted, and the
  void landing server side with `voided_by` naming the manager — stock back from
  18 to 19, the ledger still agreeing, and the drawer showing `+2705` in and
  `-2705` out so the voided sale nets to nothing
- **the Room 2 to 3 migration** run against a device holding v2 data, opening
  with its roster and sales intact
- **the approval dialog**: a cashier's own PIN refused, the refusal clearing on
  the first digit of the next attempt rather than standing as a verdict on a
  PIN nobody entered, and the keypad holding still throughout — including its
  bottom row, where backspace and clear live

## Starting a shift

Three gates, in order, each because the step after it is impossible without it:

1. **Unlock.** Pick a name, enter a PIN. Verified on device against the Argon2id
   hash the server replicated — a shift most often starts on a register that
   cannot reach anything, so an unlock that needs a round trip is one that fails
   when it matters. Five wrong PINs locks that employee out for fifteen minutes,
   counted locally, because that is where the attempts happen.
2. **Open the drawer.** A cash sale has to go somewhere; without a session the
   drawer total is unknowable and over/short becomes meaningless.
3. **Sell.**

A four digit PIN is 10,000 combinations, so the hash was never the protection.
The PIN unlocks a device a real login already claimed, it grants a cashier's
permissions rather than a manager's, and lockout does the rest.

**Permissions are enforced offline** from the replicated list. A cashier cannot
close the drawer: closing produces the over/short figure a shift is judged by,
and letting the person who is short report their own variance removes the only
check on it.

## Refunding

A refund is the most common vector for employee theft in retail, so the flow is
deliberately narrow: find the original sale by its receipt number, choose what
is coming back, say why, and have a manager approve it. There is no way to
refund an arbitrary amount against no original, because that is the hole theft
goes through and a register that makes it easy invites it.

Three things are true of every refund composed here:

- it names the original sale, so a quantity can be checked
- it names the manager who approved it
- the units it returns are claimed against the original line, so the same item
  cannot be handed back twice

The over-refund check runs **twice**. On device, `quantityRefunded` on the sale
line is claimed in the same transaction as the refund, so "only 1 of 3 can still
be refunded" is answered at the counter rather than on upload, after the
customer already has the money. The device's copy is advisory — another register
can refund the same receipt while this one is offline, and only the server knows
that — so `numeric(14,3)` on the server remains the authority.

Tax is divided back out per unit from a line total that was rounded once, which
is how a partial refund returns a proportional share; the remainder is absorbed
by the final unit rather than silently lost.

**Approval does not change who is on the register.** A manager approves standing
beside the cashier, by PIN, verified on device against the replicated Argon2id
hash — a customer is waiting, and an approval that needs a round trip is one
that fails during an outage. The cashier stays signed in, because the sale that
follows still belongs to them.

The register uploads under the **cashier's** token, and a cashier does not hold
`refund.create`. Authority therefore comes from the user the payload names in
`approved_by`, which the server looks up live and requires to be active and to
actually hold the permission — see `APPROVER_FIELD_BY_ENTITY` in
`sync.service.ts`. The device's claim is checked, not believed: a refund naming
the cashier themselves is refused exactly like one naming nobody.

Restock is per line and defaults on. An opened drink is refunded and not
restocked; restocking it anyway would make the count drift by exactly the number
of damaged returns, which is the kind of slow error that takes a full physical
count to find.

Known limits: the lookup is **local only**, so a sale rung on another register
is not on this device and the register says so rather than inventing a refund
with nothing to check against. The tender is always cash, because no payment
provider is integrated yet — a card refund must go back to the card, so that
line stays honest rather than being faked.

## Voiding

A void reverses a whole transaction that should not have happened — the wrong
item rung, the customer changing their mind at the counter. It is reached from
the same receipt lookup as a refund, and offered **only while nothing on the
sale has been refunded**: refunding one of two units and then voiding the sale
would put three units back on the shelf and more money in the customer's hand
than they ever paid. The action is hidden rather than shown and refused.

Approval is a separate permission from a refund (`sale.void`), because a shop
may well let a shift lead reverse a mis-rung sale without letting them hand cash
back against last week's receipt.

Voiding a cash sale **takes the money back out of the drawer**, on the device
and on the server, through the same rule. Without that the drawer is expected to
hold cash that was handed back, so every voided cash sale reads over by its own
amount at close — and a cashier who voided a sale and pocketed the notes would
produce a drawer that balanced perfectly.

The upload is its own `sale_void` entity rather than an edit of the sale, since
sales are append only on both sides. A void whose sale has not uploaded yet
waits rather than failing, because entities are ordered inside a batch but not
across batches.

A voided sale is not refundable — the money already went back — but the screen
says **"HH01-R1-7 was voided"** rather than "no such sale". The receipt is in the
cashier's hand; telling them it does not exist sends them looking for it.

## Pulling the catalog only when it changed

The register asks `GET /v1/sync/changes?since=<cursor>&limit=1` before pulling.
Nothing changed — the overwhelmingly common answer — and it returns having
transferred nothing. `limit=1` because it only needs to know *whether*
something changed, not what; one row settles it, and asking for more would move
data to reach the same conclusion.

The cursor is `change_log.id`, held by the server below any change whose
transaction might still be in flight. A change can therefore arrive twice, which
is harmless because applying it is idempotent, and none is ever missed — which
is the property that matters.

A failed feed read falls through to a full pull. Not being able to read the feed
is not evidence that nothing changed, and treating it as such leaves a register
quietly stale.

**This is incremental detection, not yet incremental application.** When
something has changed the register still pulls the whole snapshot rather than
fetching the individual rows the feed names. Per-entity fetching needs endpoints
returning a row in the register's own projection shape and those do not exist
yet. The win banked here is the idle case, which is almost all of them: before
this, a register polling every fifteen minutes transferred the entire catalog
every time to arrive back where it started.

**Verified on a Galaxy S22 Ultra**, both branches and back:

```
catalog current at cursor 7; nothing pulled
changes since 7; refreshing the catalog        (a brand renamed server side)
catalog: 12 variants, 12 barcodes, 3 employees, cursor 8
catalog current at cursor 9; nothing pulled
```

## Handing sales over when the network returns

Three things trigger an upload, in order of how quickly they fire:

1. **Committing a sale** enqueues an immediate run with `REPLACE`, which also
   cancels any run sitting in backoff.
2. **`ConnectivityWatcher`** calls the same thing when the default network
   becomes usable again — `VALIDATED`, not merely connected, because a register
   walking back into range is associated-but-unproven for a second or two and
   uploading into that just burns a retry. Only a transition into usable fires
   it; wifi-to-mobile handover and radio re-association produce callbacks while
   the register was online throughout, and syncing on each would have a busy
   till hammering the endpoint.
3. **The periodic job**, every fifteen minutes, as the net underneath.

The watcher exists because a satisfied constraint does not shorten a backoff.
WorkManager will release constraint-blocked work the moment connectivity
returns, so for a register that was simply offline it would have coped on its
own — but a worker that already *failed* and was rescheduled carries a timing
delay that connectivity does not clear. `syncNow`'s `REPLACE` cancels it.

**It does not cover a healthy network with a dead server.** Nothing changes from
Android's point of view, so no callback fires; that case falls to the next sale
or the periodic job. Closing it properly would mean polling a server that is by
definition already failing to answer.

**Verified on a Galaxy S22 Ultra**: airplane mode on, a sale rung and queued,
airplane mode off — `ConnectivityWatcher: network usable again; draining the
outbox`, then `SyncWorker: upload: 1 accepted, 0 duplicate, 0 rejected, 0 dead,
0 left`, on the server within twelve seconds and landing exactly once.

## Receipts

A receipt is **described, not formatted**. `ReceiptRenderer` produces an
abstract `ReceiptDocument` — text, label/amount rows, sold items, separators, a
machine readable receipt number — and whatever consumes it decides the width.
`TextReceipt` rasterizes it at a `PaperWidth`: 58mm is 32 columns, 80mm is 48.

That split is load bearing. Pre-formatted text padded to 32 columns is wrong at
every other width, and the only way back is a second template that drifts from
the first. The on-screen receipt goes through the *same* rasterizer at the same
width as the paper, so a preview cannot disagree with what the customer holds.

Amounts sit flush to the last column, because a receipt is checked by running a
finger down the right hand edge. Long product names wrap on word boundaries; a
label that would crowd the amount is truncated rather than wrapped, since the
amount is the part that has to survive.

An age restricted sale prints **that the check happened** and nothing else —
"Age 21+ ID verified", no date of birth, no licence number, no name. A receipt
ends up in a bin behind the counter, and identity data on it is a breach made
of paper. A test asserts the rendered receipt contains none of those words.

`PrinterProvider` lives in `hardware-api` and every method reports rather than
throws. The money has changed hands by the time a receipt is produced, so a
printer that is out of paper, unplugged, or whose SDK throws on a Tuesday must
never be able to fail a sale.

**Verified on a Galaxy S22 Ultra**: a two unit sale tendered at $60 rendering
`2 @ 24.99`, subtotal, tax, total, cash and change, with amounts aligned; a four
item sale showing no change line at all because payment was exact.

## Not yet built

The **ESC/POS driver**. There is no printer here to verify one against, and an
unverifiable driver that looks finished is worse than an absent one — the
interface it plugs into is done and the document it consumes is tested. The
receipt sheet says "No printer configured" rather than offering a Print button
that silently does nothing.

Store address, phone and return policy are shop configuration that does not
exist yet, so the receipt omits them rather than inventing them.

Also outstanding: the remaining hardware adapters, the promotions engine,
manager approval for price overrides, and the incremental change feed — the
catalog currently arrives as a full snapshot on each pull.

`DevProvisioning` and `DevSignIn` are development scaffolding standing in for a
real device claim flow, and both say so. Delete them when it lands.
