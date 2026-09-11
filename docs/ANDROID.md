# Android register

Kotlin, Jetpack Compose, multi-module Gradle.

## Status

| Module | State |
|---|---|
| `core-domain` | **Money type built, 13 tests passing.** Pure Kotlin, no Android. |
| `app` | **Shell builds and packages.** Register layout renders against static data. |
| `core-data` | Module configured. Room entities are next. |
| `core-sync` | Module configured. WorkManager outbox drain is next. |
| `hardware/hardware-api` | Module configured. Interfaces are next. |

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

## Not yet built

Everything that makes it a register: the Room schema and encrypted local store,
the sync outbox and its WorkManager drain, scan-to-cart, the pricing engine,
payment, receipts, hardware adapters, PIN unlock, and cash sessions on device.
