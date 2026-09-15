# Changelog

Notable changes. Newest first.

## Full editing for items and customers, and archive instead of delete

First of four passes toward customer/vendor management, AI-mapped import/export and marketing. Asked what
"delete" should mean, the answer was **always archive** — which is what this app already did for products
and never exposed for anything else.

- **Archive everywhere.** `status` is now settable on a single product (`updateProductSchema`) and on a
  customer, with archive/restore on both detail pages and a "show archived" view on the customer list.
  Nothing is destroyed: sale lines, purchase orders, invoice lines and refunds all reference these rows,
  so deleting would either break that history or drag it along. An archived record disappears from the
  back office, search and the register — the customer search endpoint is the same one the register calls,
  and it still defaults to active only, so archiving genuinely removes someone from the counter.
- **Customers can be created from the back office at all**, which they couldn't before, and the edit form
  covers the whole record rather than five fields: birthday month/day, tags and status joined name, phone,
  email and notes. `tags` and `status` were missing from the create/update contracts entirely.
- **Compliance is editable.** `updateProductSchema` accepted a `compliance` object and
  `CatalogService.updateProduct` silently ignored it, so an age restriction could only ever be set at
  creation, from the AI's guess, and never corrected. It now upserts `product_compliance` — for a shop
  selling vape and THC this is the field the register actually enforces at the counter.
- **PLU is editable** on a variant (keypad code for items rung up without a barcode).

Two fixes that came out of using the thing:

- **Every validation failure in the back office read as "the request did not validate."** The API answers
  a rejected body with that sentence *plus* an `issues` array naming each field, and `ApiError` was
  dropping the array. It now folds the issues into the message, so a bad phone says
  `phone: phone must be E.164, e.g. +15125550123`. That applies to every form in the app, not just the
  new ones.
- **Phone numbers are normalized on the way in.** The contract stores E.164 so a lookup by phone matches,
  but nobody types `+15125550123` — and the form's own placeholder suggested a format that would be
  rejected. Ten digits, or eleven starting with 1, now become E.164 automatically; anything else is passed
  through for the API to judge rather than guessing a country code.

Verified live: a customer created with a typed `(512) 555-0199` stored as `+15125550199` with birthday and
tags intact, archived, confirmed absent from the active search and present under archived, and restorable;
compliance saved to a product that had no compliance row and read back correctly after a reload. One bug
caught by checking the database rather than the success message — `plu` was wired through the contract and
the SQL but not the dashboard action, so the form said "Saved." while silently discarding it.

## A dashboard worth opening

Last of the four back-office passes. The dashboard showed three numbers about today and a list of recent
sales -- true, but nothing anyone would act on. The reference product answers this with P&L, balance
sheet and bank balance cards, which need a general ledger this app doesn't have. What it *can* answer,
from data already on hand, is the more immediately useful question: **what is waiting on me right now.**

`GET reports/needs-attention` returns six open loops in one read:

- **Stock below zero** -- not a reordering problem but a counting one: something sold that the system
  didn't know was there, so valuation and reordering downstream of it are already wrong. Added beyond the
  four signals originally planned, because the dev data turned out to have one and nothing would have
  surfaced it: the item had no reorder point, so "below reorder point" couldn't see it.
- **Selling below cost** -- losing money on every one that goes out the door. Zero-cost items are
  excluded: nobody having said what it costs is a different problem from selling under cost.
- **No price set** -- the register refuses these outright, so they can't be sold at all.
- **Below reorder point** -- by the shop's own reorder point.
- **Not sold in 60 days**, with stock on hand -- money sitting on a shelf.
- **Invoices parsed but never committed** -- stock the shop believes it received and didn't.

Each group is one query returning both its first few rows and a `count(*) OVER ()` total, so "12 items,
here are 5" costs one round trip per signal rather than two. The endpoint returns the numbers that make
each item qualify and leaves the phrasing to whoever renders it, since what makes an item interesting
differs per group. Groups with nothing in them don't render at all -- a dashboard of five headings all
reading "0" teaches people to stop reading it -- and when everything is clear it says so plainly.

Verified against the real dev database, where it immediately found things worth knowing: a variant with
no price at all, five items with stock that has never sold, four invoices left uncommitted, and Watermelon
Ice sitting at -2 on hand. Below-cost was proved with a throwaway item priced at $7.99 against a $10.00
cost, which also confirmed it drops out again once the item is archived. Typecheck, unit tests and the
Postgres schema suite including RLS all green; probe archived afterward.

## Case costing and margin

Third back-office pass, and the one that answers "what am I actually making on this." A shop buys a case
and sells a unit; until now a variant carried only its unit `cost`, so the division happened on a
calculator next to the invoice and **margin appeared nowhere in the app at all**.

- **Migration `0016_case_costing.sql`** adds `case_cost`, `case_discount`, `case_rebate` and
  `default_margin` to `product_variants`. The schema was already shaped for this: `cost` has been
  `numeric(14,6)` since 0002 precisely "because a case of 12 at $5.00 is a unit cost of 0.416667 and
  truncating that to cents corrupts margin within weeks."
- **`cost` is now derived, not entered, whenever there's a case cost to derive it from** --
  `(case_cost - case_discount) / case_quantity`, computed in `updateVariant`'s own UPDATE so that
  changing only the units-per-case re-divides the case cost already on file. A unit cost that disagrees
  with the case it came from is the bug the arrangement exists to prevent. Entering cost directly still
  works for anything bought by the each.
- A **rebate is deliberately outside that derivation**: it arrives after the fact from the manufacturer,
  so it belongs in "margin after rebate" rather than in the cost inventory is valued at.
- **Cost & Margin tab** on the item: units/case, case cost, discount and rebate, with cost-per-unit,
  margin and margin-after-rebate recalculating as they're typed, a below-cost warning, and a target
  margin that says what the item would have to sell for -- click the figure to load it into the price
  box. Cost and price save separately, because a price change is its own event with its own history.
- **Margin in the catalog list**, with anything selling under cost called out in red.
- **Price groups gained the signal that makes grouping worth doing**: how many members have drifted off
  the price the rest share. The group's price is taken as the most common one among members (`mode()`),
  and an unpriced member counts as mismatched -- it is exactly as wrong at the counter as one priced
  differently. Shown as "Off the group price", linking into the group.
- `postgres-error.ts` learned the five new check constraints, so a discount larger than the case cost
  reads as "a case discount can't be more than the case costs" rather than "the request violates a rule
  the database enforces".

All margin arithmetic lives in `lib/margin.ts` so the item form, the catalog list and the price groups
can't disagree about it -- including the distinction the file is emphatic about: margin is taken on the
retail price, not on cost ($4 bought and $5 sold is a 20% margin and a 25% markup, and confusing the two
is how a shop thinks it's making more than it is).

Verified against the real dev database: case cost 40 / discount 5 / units 5 deriving a $7.00 unit cost
through the API, and re-deriving to $3.50 when only the units-per-case changed; the live readout matching
by hand on screen; a deliberately drifted price group reporting exactly one mismatched member. Schema
tests updated for the new migration and its five checks (72 table-level checks became 77) and passing
against real Postgres including RLS. Probe products archived and the probe group removed afterward.

## Item page: codes, carton mapping, and price/purchase/sales history

Second of the four back-office passes. The item page had Details and Variants; the reference product this
shop uses has a tab strip per item -- Carton Item Mapping, Item Codes, Price History, Purchase History,
Sales History -- and almost all of it was data this app already stores and simply never showed.

- **Item Codes** and **Carton Mapping** are separate tabs split by what a code *means*: a code whose
  `units` is 1 scans as one of the item, a carton code carries more and makes the register ring up a
  case. Both reuse the add/remove actions built for Item Lookup last pass, so carton mapping is now
  reachable from the item itself rather than only by scanning it.
- **Price History** is a new `GET catalog/variants/:variantId/price-history`. It needed no new storage:
  `setVariantPrice` already closes the open row and inserts another instead of updating in place, so the
  table *is* the history. Shows each price, the window it applied for, `current` on the open one, and who
  changed it.
- **Purchases** and **Sales** are one read of the existing `inventory/ledger?variant_id=`, filtered by
  reason -- `receiving`/`vendor_return` against `sale`/`refund`/`online_order`. They were always the same
  ledger with different reasons, so this asks once and splits it rather than adding two endpoints.
- These five tabs belong to a *variant*, not a product, so they act on a selected one with a picker that
  doesn't render at all for a single-variant item -- which is most of them, and which then reads exactly
  like the flat item page it's modelled on.

Verified live on Geek Bar Pulse X: a carton code added from the Carton Mapping tab appearing as
`case · 10 units` and correctly absent from Item Codes; price history rendering the real effective-dated
chain with `current` and per-change attribution; purchases showing the receiving movement with its unit
cost; sales showing sale and refund lines. Typecheck clean, test carton code removed afterward.

## Navigation shell: grouped sidebar, launcher grid, Ctrl+K palette

First of four passes prompted by screenshots of Modisoft, the back office this shop uses today, with the
direction "make menus, functions, UI/UX similar to this but more useful, smart and user friendly." Asked
which piece to start with, the answer was all of them; asked whether to keep our sidebar or adopt their
launcher grid, the answer was both. The remaining three passes -- deeper item page, case-cost/margin math,
an actionable dashboard -- are sequenced behind this one.

Until now the back office had a flat ten-link sidebar with no search, no recents, no favorites, and not
even an active-page highlight.

- **One registry, three surfaces** (`lib/navigation.ts`). Every destination declares its label, href,
  sidebar group, launcher surface(s), icon and search keywords in one place. Shipping two navigation
  systems invites exactly one failure -- a page added to one and missed by the others -- and a single
  source is what prevents it. `activeEntry()` resolves the current page by longest matching href, so
  `/catalog/<id>` highlights Items and `/inventory/purchase-orders` highlights Purchase Orders rather
  than Stock on hand.
- **Sidebar** (`_components/AppNav.tsx`): grouped into Overview / Catalog / Inventory / Purchasing /
  People / Marketing, with the active page highlighted, a ☆ per row that pins it to a Pinned section at
  the top (and removes it from its group, rather than showing it twice), and Recent at the bottom
  excluding the page being looked at.
- **Launcher** (`_components/Launcher.tsx`): the 9-dot button opens their tile-grid pattern with
  All / Reports / Setup tabs, a filter box and Recent View.
- **Command palette** (`_components/CommandPalette.tsx`): ⌘K/Ctrl+K, arrow keys, Enter, Esc. This is the
  part that goes past the original -- Modisoft's search filters menu tiles, this searches the menu *and*
  real records: items via the existing `/catalog/products?q=` and customers via `/customers?q=`, fanned
  out by a `searchEverythingAction` Server Action so tokens stay in their httpOnly cookies. Menu matches
  are computed locally so they appear on the first keystroke instead of after a round trip; record search
  is debounced 180ms. One endpoint failing (a permission the signed-in role lacks) returns that half
  empty rather than blanking the results.
- **Pins and recents** (`_components/nav-state.ts`): `localStorage`, read only after mount so there's no
  hydration mismatch, every accessor guarded since a private window throws rather than returning null.
  Per-browser rather than per-user is deliberate for one shop on a couple of machines; moving to a
  per-user endpoint later touches only that file.

Verified live: the whole palette flow keyboard-only (Ctrl+K, type `geek`, arrow, Enter → the product
page); `invoice` returning the Invoices page plus the Upload-an-invoice action; the launcher's Setup tab
narrowing to the five setup pages; pinning surviving a full reload; recents filling in across navigation.
A fresh tab loads with zero console output -- no hydration warnings. The 9-dot button was enlarged after
its original hit area proved too small to click reliably.

## Item Lookup page, and the missing half of carton→item mapping

Two asks: a menu option to add or check a single item, and "something like carton-item mapping" --
clarified as a carton scan ringing up N of the single item (a carton of 10 packs = 10 packs at the pack
price), with the lookup page scan-first and typing as the backup.

**The carton path turned out to be already built end to end, except for the one step that creates it.**
`variant_barcodes` has carried `kind` and `units` since `0002_catalog.sql`, whose own column comment reads
*"a case barcode adds 12, not 1"*; `CatalogService.scan` already selects `b.units AS scan_units`;
`sync.service.ts` already ships `kind`/`units` to devices with `variant_barcode` as a tracked change
entity; and the Android register already does `units = scanUnits.toDoubleOrNull()?.toInt() ?: 1` under the
comment *"A case barcode adds a case."* What was missing: nothing could write such a row.
`addBarcodeToVariantTx` hardcoded `'upc'` and `'1'`, had no controller route at all (only invoicing's
"Also known by this code" reached it internally), and `barcodeSchema.kind`'s enum didn't even include
`case`, contradicting the column's own documented vocabulary. So this entry is mostly a write path.

- **Carton mapping**: `'case'` added to `barcodeSchema.kind` (the column is plain `text` with no CHECK and
  every existing row is `'upc'`, so no migration). `addBarcodeToVariant` now takes the existing
  `createBarcodeSchema` shape instead of a bare string, keeping today's `'upc'`/`'1'` as defaults so its
  invoicing caller behaves exactly as before, and gains `POST catalog/variants/:variantId/barcodes`.
  `removeBarcodeFromVariant` + `POST catalog/variants/barcodes/:barcodeId/remove` deletes an alternate or
  carton code but refuses the primary -- a variant whose primary code is gone still appears in search and
  still fails at the counter, the exact state `createProduct` refuses to create in the first place.
  `postgres-error.ts` learned `barcodes_org_code_key`, `barcodes_primary_key` and `barcode_units_positive`,
  so a duplicate code or a zero-unit code reads as a sentence instead of "that record already exists".
- **Item Lookup** (`/items`, new sidebar entry): an autofocused scan box that re-takes focus after every
  lookup, so a scanner can be fired at it repeatedly. Resolution order is exact code, then name search,
  then an inline create form prefilled with the code as both SKU and primary barcode (this business treats
  the two as the same number). Each variant shows SKU, price, stock and its codes, with `= N units` on
  anything standing for more than one, an add-code row defaulting to `case`, and a ✕ on non-primary codes.
- Exact-code resolution is a new `GET catalog/resolve/:code` rather than the existing `scan`, deliberately:
  `scan` serves the register, so it refuses an item with no active price ("selling at a price nobody set is
  how a shop loses money quietly") -- but an unpriced item is precisely what someone looking a code up in
  the back office needs to find in order to fix it. It reuses `findVariantBySkuOrBarcodeTx`, which is also
  what makes typing a SKU work without a second code path. Stock is a second read
  (`inventory/stock/:variantId`) kept beside the product rather than merged into it, since the catalog's
  product endpoint carries no stock and pretending otherwise would be a lie in the type.

Verified live: a carton code added to Geek Bar Pulse X | Miami Mint, scanned back, reporting *"That was a
case code -- scanning it at the register rings up 10 of this item"*; confirmed in Postgres as
`kind=case, units=10.000` **and** as a `variant_barcode` insert in `change_log`, which is what actually
carries it to the register on the next delta sync. Duplicate code, zero units, and primary-code removal all
refused with readable messages. Unknown code → create → card, end to end. Enter is handled explicitly on
the scan box rather than left to implicit form submission, since which key a scanner sends is configurable
and that keystroke is the entire interaction on this page. Typecheck clean; test item archived and the test
carton code removed afterward.

## Redesign invoice-review's create-product panel: uniform horizontal rows, AI-suggested variants

Prompted directly by a screenshot of the invoice-review "create or attach a product" panel with the
feedback that it was confusing: vertical stacked fields, a required top-level SKU that made no sense once
a product was meant to have several named variants, and a "pick a variant" resolve dropdown that listed
every variant in the whole catalog instead of anything relevant to the product being created.

- **One product line, uniform variant rows.** Product name/Brand/Category are now a single horizontal line
  (hidden entirely when attaching to an existing product instead, since those fields are server-ignored in
  that case anyway). Every variant below it is an identical row -- SKU, variant name, price, a remove
  button -- visually indented under the product line. There's no more special "first variant" with a
  required top-level SKU distinct from "extra" rows; the wire format's top-level `sku`/`variant_name`/
  `price_minor` vs. `extra_variants[]` split still exists (unchanged, zero API/contract changes), but it's
  now purely an action-layer mapping detail -- row 0 fills the former, the rest fill the latter.
- **A shared "starting price"** replaces the old required "retail price," shown live as each blank variant
  row's own price placeholder. A row's own price still overrides it; leaving it blank still falls back to
  the starting price server-side (the fallback already existed for `extra_variants[]`; row 0 now gets the
  same treatment, resolved client-side before sending since the wire format's top-level price has no
  server-side fallback of its own).
- **AI-suggested variants via real web search.** New `AiService.suggestProductVariants` uses the OpenAI
  Responses API's hosted `web_search` tool (deliberately not `.parse()`/Structured Outputs, since combining
  a hosted tool with strict schema output isn't something to assume works -- it reads the model's plain
  text answer and parses it defensively instead) to find a product's actual known flavor/size names, mirrored
  end-to-end through `CatalogService.suggestVariants` / `POST catalog/variants/suggest` /
  `suggestVariantsAction`, the same shape as the existing compliance-suggestion feature. Suggestions render
  as a checklist; checking several and clicking "Add checked as variants" appends one pre-filled row per
  name with SKUs left blank to fill in.
- **The existing-variant resolver stayed** -- it links a line to something that already exists in the
  catalog, which AI-suggested names that don't exist yet can't substitute for -- but moved into a collapsed
  "Already have this in your catalog? Link it directly" section under the (now primary) create-product
  panel, so the two stop reading as the same control. Resolved/matched lines now display as
  `Product | Variant` throughout this page.

Verified live against the real invoice the original screenshot came from, plus a disposable test invoice:
the AI-suggest button returned genuine real-world flavor names for a well-known vape product; checking two
and adding them produced correctly pre-filled rows; submitting 3 variant rows with only one priced
explicitly created all 3 under one product with the other two correctly priced from the starting-price
fallback (confirmed via the API directly, store-scoped price row included); attaching to an existing
product correctly hid the product-level fields and still required a name per row. Typecheck clean across
`@snappos/api`, `@snappos/dashboard`, `@snappos/contracts`. Test product archived (no product/invoice
delete endpoint exists in this app -- archived instead, matching how the catalog already treats retirement
everywhere else) after verification.

## Client-side interactivity for the rest of the back office

Continues the previous entry's pattern (Server Actions called from Client Components instead of
`redirect()`-ending `<form action>`s) across every remaining page that mutates anything: price
categories, purchase orders and inventory adjustments (including the PO-creation and invoice-line-split
fixed row counts, `LINE_ROWS`/`SPLIT_ROWS`, both converted to "click Add for one more row"), customers,
employees (details, roles, PIN reset, the onboarding checklist, and the onboarding task template editor),
loyalty settings, and scheduling. Read-only list/search pages (catalog's own list aside, which already
needed conversion for its bulk actions) were deliberately left as plain GET navigation -- an idempotent
search is a different, much lower-stakes kind of "page changes" than a mutation ending in a redirect, and
converting every list's search box wasn't worth the added surface for this pass.

The price-category detail page's speed-scan box, previously the one page in this app with page-local
vanilla JavaScript (a deliberate, contained exception from last time, since the rest of the app was still
zero-JS), is now plain React state like everywhere else -- the whole page is a client component now, so
the reason for that exception no longer applies. Its Route Handler proxy is retired along with it;
`scanAddToPriceCategoryAction` is called directly as a Server Action instead, the same as every other
mutation in this pass.

Found and fixed two real bugs live during verification, both worth remembering as a pattern:
- **`employees/[id]`**: assigning a role appended a fabricated entry to the roles list client-side, because
  the assign-role endpoint only ever returned `{ ok: true }` -- never the new assignment's row id or the
  role's display name. The added row rendered with no name and a "Remove" button pointing at nothing.
  Fixed by calling `router.refresh()` instead of guessing at the response shape, but that surfaced a second
  issue: the component's `employee` state was seeded once from props via `useState`, so `router.refresh()`
  alone doesn't update it -- a `useEffect` syncing state from props on every change was needed too. Any
  page mixing local optimistic state with an occasional full refresh needs this same sync; the pages that
  only ever refresh (never hold local state) don't, and the pages that only ever hold local state (never
  refresh) don't either -- it's specifically the mix that bites.
- Confirmed while fixing the above: `e.currentTarget` inside an async `startTransition` callback (i.e.
  after an `await`) can no longer be relied on -- React nulls it out once the synchronous part of the
  handler returns. Audited every converted file for this exact shape; found and fixed one instance
  (`inventory/[variantId]`'s adjustment form calling `.reset()` on it after the action resolved) by
  capturing the form reference in a local variable before entering the transition, which is what every
  other converted form was already doing for its `FormData` read.

Verified live: price-category speed-scan (add and remove, header stats updating correctly, no reload);
purchase-order creation's vendor-quick-add transitioning into the full order form entirely via client
state; a scheduling shift added and cancelled with the calendar grid updating in place; and the employee
role bug above, reproduced, fixed, and re-verified showing the correct name and a working "Remove" on the
newly assigned role. Full verification suite green: typecheck, lint, all contracts/db/pricing-spec tests
(pglite and real Postgres, including RLS), and a clean dashboard production build -- every mutating page
now ships a small client bundle where it previously shipped none. All test data (a test vendor, and a
price-group split that resulted from bulk-pricing a subset of an already-ambiguous pre-existing group
during verification -- noted, not reverted, since no data was lost, only its grouping changed) accounted
for; two additional `invoice_imports` rows turned up during cleanup that this pass didn't create -- left
alone and flagged rather than assumed safe to delete.

## Client-side interactivity for catalog and invoice review, sharper invoice matching

"Add JS in whole back office, I don't want the page to refresh every time I click something," plus
"improve invoice parsing, matching product information, tabs and UI/UX." This app had been built with
zero client-side JavaScript everywhere -- every click was a real Server Action ending in `redirect()`,
which is what read as "the page refreshes." The literal ask ("client components fetching the API
directly") turned out to be incompatible with this app's own security model: auth tokens live in
**httpOnly cookies** specifically so client JS can never read them (`lib/cookies.ts`'s own words: "the
whole point of the backend-for-frontend pattern this app uses"). What actually delivers "click something,
it updates instantly, no navigation" without that regression: keep every Server Action's real work
(validation, permission checks, audit logging, the actual `apiFetch` call) exactly as it is, call it from
a Client Component instead of a plain `<form>`, and stop calling `redirect()` -- return a result the
component merges into its own state instead. This pass converts the two highest-value, most-requested
areas end to end; the rest of the app (customers, employees, inventory, purchase orders, loyalty,
reports, scheduling, price categories) is the same technique, still to be applied page by page.

- **Invoice matching fixes**, all backend-only: the vendor-SKU-memory tier (`vendor_variants`) was
  completely dead in the shipped product -- nothing in the dashboard ever set `invoice_imports.vendor_id`,
  so that tier could never fire and `commit` should have refused every invoice. `/invoice-imports/new`
  now has a vendor picker. Fuzzy matching and the AI candidate shortlist used to score only
  `product_name || variant_name`, so a wrong-brand item with an identical name could crowd the real match
  out of the AI's top 5 candidates entirely, reading as "no match" even though the product existed --
  brand and category now join the scored text in both tiers. Neither tier ever saw the line's own
  quantity or cost, so a single unit and a 12-pack of a near-identically-named product couldn't be told
  apart -- `match()` now selects them, both AI schemas carry them, and the matching prompt tells the model
  to use cost-per-unit as a tiebreaker. Exact-match tiers (barcode, vendor SKU) are now case/whitespace
  normalized, matching how the catalog's own SKU index already works. CSV header recognition changed from
  requiring an exact string match to recognizing a word inside a compound header (`"Item Description"`
  now finds `description`), specific fields resolving before the generic ones so one column is never
  claimed by two different fields. A PDF/EDI document long enough to hit the extraction character limit
  now says so on the review page instead of silently dropping its tail.
- **The pattern**: a page's outer Server Component keeps doing the exact same initial data fetch as
  before; its interactive body becomes a Client Component that holds that data as local state. A mutation
  either updates that state directly from what the action returned, or -- for the more complex pages --
  refetches the canonical record through a new same-origin Route Handler (`api/catalog/search`,
  `api/invoice-imports/[id]`, alongside the pre-existing `api/price-categories/[id]/scan`), the same
  "browser never talks to the API directly" shape already established. A hand-rolled `<Tabs>` component
  (plain `useState`, no new dependency -- nothing like it existed anywhere in this app yet) backs the
  product page's new tabs. Every fixed `Array.from({length: N})` blank-row block converted this pass
  became "click Add to reveal one more row" -- pure client state, no server round trip just to show a
  blank input.
- **Invoice review** (`invoice-imports/[id]`): resolve/ignore/create-product/add-secondary-sku all commit
  instantly with no navigation. The 7 fixed blank `extra_variants` rows are gone -- "Add another variant"
  reveals one at a time, and one submission can still create a product with several flavors/sizes at
  once, exactly as before. Found and fixed a real bug live: `defaultValue` only applies when a form field
  first mounts, so the resolve dropdown and the create-product form's prefilled fields kept showing their
  original (usually empty) values even after "Find matches" filled in a real suggestion for that exact
  line, since the already-mounted elements never picked up the new default. Fixed by keying those elements
  on the data that should re-baseline them, so they remount (and re-baseline) exactly when that line's own
  suggestion actually changes, and stay put (preserving in-progress typing) for everything else.
- **Catalog**: the product page (`catalog/[id]`) now has Details and Variants tabs; "Add variant" no
  longer shows an always-open form -- clicking it reveals one, submits, and collapses back, ready to add
  another. `catalog/new`'s "Suggest with AI" fills the compliance section from local state instead of a
  full-page redirect carrying every field as a query parameter. The list page's search box and its three
  bulk actions (field update, bulk price, add-to-price-category) all update the table in place.

Verified against the real dev database and API, including the actual invoice that originally prompted
the ingestion feature (`INV_2026_09_0010.pdf`): uploaded with a vendor attached, parsed (19 lines,
confirmed no navigation at any point), ran matching and got both a real 100%-confidence catalog match and
clean AI brand/category suggestions on the rest, resolved a matched line, and used two "Add another
variant" clicks to create one product with three variants (a main item plus two dynamically-added
flavors) in a single submission -- confirmed all three rows landed correctly in the catalog. Verified the
`defaultValue` bug above by reproducing it, fixing it, and re-confirming the resolve dropdown and
create-product prefill both now update correctly after "Find matches." Verified the catalog list's live
search, a bulk price change across two selected rows (and that unselected rows were untouched), and the
product page's tabs plus dynamic add-variant, all with zero page navigations. Full verification suite
green: typecheck, lint, all contracts/db/pricing-spec tests (pglite and real Postgres, including RLS),
and a clean dashboard production build. All test data (invoice import, test vendor, test products and
variants) removed afterward.

## Price categories, and AI-suggested age restrictions

Two requests: a way to group items so their price can be bulk-changed in one shot later (with two ways
to build a group -- picking from a list, or scanning items back to back), and a way to flag THC/vape/
tobacco items as age-restricted at creation time, with AI suggesting the flag instead of a manager
having to know every regulated SKU by heart.

- **Price categories** turn out to be ~80% already built under the name "price groups" --
  `price_groups` + `product_variants.price_group_id` + `CatalogService.bulkSetPrice` (`POST
  /variants/bulk-price`) already formed a group from a variant selection and repriced it all at once in
  one transaction. What was missing was a *named*, browsable category and a way to build its membership
  without repricing on every change. New `CatalogService.createPriceCategory`/`listPriceCategories`/
  `getPriceCategory`/`addVariantsToPriceCategory`/`removeVariantFromPriceCategory`/
  `scanAddToPriceCategory` (all reusing `price_groups`/`product.update`, no new permission, no
  migration) and matching `POST/GET /catalog/price-categories[...]` routes. `bulkSetPrice` itself is
  unchanged -- it's still exactly what "set this category's price" calls, via `price_group_id`.
- Dashboard: `/catalog/price-categories` (list), `/new` (name only), `/[id]` (members, a "set price for
  everyone" form, and the scan box below). The existing `/catalog` list page's row-checkbox selection
  gained a third bulk action, "Add selected to category" -- the traditional way to build a category,
  reusing the same search/select UI already there rather than building a second one.
- **Speed-scan**: the one page in this dashboard with page-local JavaScript, by deliberate choice --
  asked directly, given every other page here is zero-client-JS, and chose a smoother non-reloading scan
  experience over a page reload per scan. A new same-origin Next.js Route Handler
  (`app/api/price-categories/[id]/scan/route.ts`) is the only proxy of its kind in the app: the browser
  calls it, it calls the same server-only `apiFetch` every Server Action already uses, so auth and
  business logic stay exactly where they already live. A real `<form>` with a genuine Server Action
  fallback still works with JavaScript disabled; the inline `<script>` on top of it is plain DOM, no
  framework, confined to this one file. Each scan commits immediately (no pending/draft state to lose);
  a mis-scan is corrected with the same per-row "Remove" button used for anything else.
- **Age restriction**: `product_compliance` (`minimum_age`, `id_scan_required`, `regulated_class`,
  `contains_nicotine`, `contains_cannabinoid`, `is_smokable`) turned out to be fully wired already --
  `createProductTx` already saved it, the scan endpoint already returned it, and the Android register
  already blocks checkout on it (`RegisterScreen.kt`'s "blocks PAY rather than warning beside it"
  age-gate). The only real gap was that nothing in the dashboard ever *set* it. `/catalog/new` gained a
  collapsible compliance section, and a new `AiService.classifyCompliance` (same
  `client.responses.parse()` + `zodTextFormat()` shape as the existing invoice-matching methods, same
  rule: only ever a suggestion, never written to the catalog directly) backs a "Suggest with AI" button
  that round-trips through a new stateless `POST /catalog/compliance/suggest` and re-renders the same
  form with every field -- including everything the user had already typed -- prefilled from the
  suggestion, still fully editable before the real "Create product" submit.

Verified against the real dev database and API: created a price category by name, added members both
by checking rows on the catalog list and by scanning SKUs on the category's own page (confirmed an
unknown code shows a clear "not found" instead of silently doing nothing), set a price and confirmed
every member repriced together in one transaction, and removed a member. Found and fixed a real bug
along the way: `removeVariantFromPriceCategory`'s `UPDATE ... SET price_group_id = NULL ... RETURNING
price_group_id` always returned the post-update `NULL`, so the "did this actually remove a member"
check always failed even on a genuine match -- fixed by joining against a pre-update snapshot so
`RETURNING` reports the old value instead. Verified the AI compliance suggestion against a real THC
product ("Sherpa THC Seltzer 100mg Soda" -> correctly flagged age-restricted, 21+, consumable_hemp,
99% confidence) and an ordinary one ("Bottled Spring Water" -> correctly not restricted), then created
the THC product for real and confirmed `product_compliance` persisted exactly what was submitted and
that `GET /catalog/scan/:barcode` returns it. Full verification suite green: typecheck, lint, all
contracts/db/pricing-spec tests (pglite and real Postgres, including RLS), and a clean dashboard
production build. All test data removed afterward, including reverting two seed variants' price back to
what it was before bulk-pricing them during the test. Left one pre-existing, unrelated finding
unresolved rather than guessing at it: an unnamed price group (4 Geek Bar Pulse X variants at $23.99)
that predates this work and wasn't created by this pass -- likely uncleaned test debris from an earlier
phase, surfaced to the user rather than deleted.

## Invoice review: brand auto-creation, SKU=UPC, and inline product creation

The user tested the shipped invoice-ingestion system against a real vendor invoice and hit several
friction points in the review page itself: AI brand guesses had nowhere to go, creating a product
meant leaving the page, SKU and barcode were shown as two redundant fields, and there was no way to
add several flavors of one new product without visiting its page repeatedly afterward.

- **Brands**: `CatalogService.createBrand` and `POST /catalog/brands` (`product.create`) finish off
  `createBrandSchema`, which existed in contracts with no backend behind it. `createProductSchema`
  gained an optional `brand_name`; `createProductTx` resolves it through a new private
  `findOrCreateBrandTx` (case-insensitive lookup, insert if not found) whenever `brand_id` isn't given,
  so a free-text brand from an invoice line creates itself the first time it's seen. The AI matching
  prompt (`MATCHING_INSTRUCTIONS` in `ai.service.ts`) now names the concrete pattern that tripped up
  the real invoice -- the brand is very often just the first word or two of the line's own description
  ("SHERPA THC SELTZER" -> "Sherpa") -- which took it from missing almost every brand on that invoice to
  18 of 19 correct.
- **SKU = UPC**: the invoice-review product-creation form now has one "SKU / UPC" field. The action
  sends it as both the variant's `sku` and its sole barcode; `insertVariant`'s existing
  `is_primary ?? i === 0` makes it the primary barcode automatically -- no schema or data-model change,
  since this business treats the two as one number but the underlying tables still have their own
  reasons to stay separate.
- **`CatalogService.createProduct`/`addVariant`** are now thin `withOrg` wrappers around new public
  `createProductTx`/`addVariantTx`, the same tx-extraction shape `PurchasingService` and
  `OnboardingService` already use -- needed so invoice-line product creation can create a product and
  resolve the line in one transaction. `CatalogModule` already exported `CatalogService`, so
  `InvoicingModule` could import it directly.
- **`POST /v1/invoice-imports/:id/lines/:lineId/create-product`** (`purchasing.create`): one inline
  form serves both "brand-new product" and "new variant on an existing one." It cross-checks the typed
  SKU against `product_variants.sku`/`variant_barcodes.barcode` first (`findVariantBySkuOrBarcodeTx`) --
  if it already resolves to a variant, the line is simply matched to it instead of creating a
  duplicate. Otherwise it creates against `existing_product_id` (via `addVariantTx`, price defaulting
  to that product's current price) or creates a brand-new product (via `createProductTx`). Up to 7
  `extra_variants` in the same submission add more flavors/sizes of whichever product was just
  resolved, skipping silently over any row whose SKU turns out to already exist rather than failing
  the whole submission.
- **`POST .../add-secondary-sku`** (`purchasing.create`): for the "AI found the right product by name
  but this invoice's code doesn't match anything on file" case -- one click adds the line's own
  `parsed_vendor_sku` as a second, non-primary `variant_barcodes` row on `ai_suggested_variant_id`
  (`addBarcodeToVariantTx`) and resolves the line to it.
- Dashboard (`invoice-imports/[id]/page.tsx`): a line with an AI-suggested match gets a small "Also
  known by this code" button; a line with none gets a full always-visible inline block (existing-product
  picker, SKU/UPC, name, variant name, brand, category, price, 7 extra-variant row slots, one submit
  button) pre-filled from whatever the AI already found -- matching the fixed-blank-row-slots pattern
  already used by PO creation and line-splitting, rather than a dynamic add-row button.

Verified against the real dev database and the actual invoice that prompted this
(`INV_2026_09_0010.pdf`, 19 lines): re-uploaded, re-parsed, and worked every line through the rebuilt
review page. Confirmed a new brand and a brand-new product were created from one line with only
SKU/name/price filled in; added multiple flavors of one new product through the extra-variant rows in
a single submission; attached a further line to that same product as a new variant and confirmed its
price defaulted from the product's own price; confirmed a manually-typed already-existing SKU
auto-matched instead of duplicating; confirmed "add as alternate SKU" added a second barcode row
without disturbing the first. Found and fixed a real bug during this pass: both the Zod schema and the
dashboard action originally required product name + price whenever no existing product was picked --
which wrongly rejected the legitimate case of typing an already-known SKU expecting it to auto-match,
since neither validation layer can know in advance (without the database lookup) whether that SKU is
actually new. Moved that requirement out of the schema and into `InvoicingService.createProductForLine`
itself, in the branch only reached once the SKU has already been confirmed genuinely new; re-verified
live that a bare already-existing SKU now correctly auto-matches instead of being blocked. Full
verification suite green: typecheck, lint, all contracts/db/pricing-spec tests (pglite and real
Postgres, including RLS), and a clean dashboard production build. All test data (the invoice import,
vendor, three test products with their variants, and three test brands) removed afterward.

## Employee onboarding checklists

One org-wide checklist template, managed on its own screen; hiring a new employee automatically
snapshots whatever tasks are active at that moment into a fresh per-employee checklist -- no separate
"start onboarding" step. Reuses `employee.view`/`employee.manage`; no new permissions.

- New `onboarding_task_templates` (the shared, editable list), `onboarding_checklists` (one per
  employee, started automatically), and `onboarding_checklist_items` (a **snapshot** of the template's
  title at the moment of hire, not a live reference) tables. Retiring or editing a template item only
  changes what *future* hires see -- it never rewrites a checklist someone already has, the same
  reasoning `purchase_order_lines.unit_cost` already captures a price at order time rather than reading
  it live.
- `EmployeesService.create` now calls `OnboardingService.startChecklistTx` inside its own existing
  transaction, so a new hire and their checklist either both exist or neither does. There is
  deliberately no endpoint to start one by hand -- onboarding only ever begins at hire time.
- A manager can check off or reopen any item (both are recorded with who and when), and add a one-off
  item to one specific employee's checklist without it becoming part of the shared template. The
  checklist's own `completed_at` is maintained automatically -- set the moment the last item is
  checked off, cleared again the moment anything is reopened or a new item is added -- rather than a
  separate status a person has to remember to update.
- Dashboard: `/employees/onboarding` manages the template (edit title/description, toggle active,
  add new tasks); the employee detail page gained an "Onboarding" section with per-item check-off/
  reopen controls, a progress count, and an add-one-off-task form. An employee hired before this
  feature existed simply shows "no onboarding checklist" -- a permanent, expected state for them, not
  an error.

Verified against the real dev database and through the dashboard's own UI: added three template tasks,
hired a test employee and confirmed their checklist snapshotted exactly those three; checked off two,
confirmed the checklist wasn't yet marked complete, checked off the third and confirmed it auto-completed,
then reopened one and confirmed it un-completed again; added a one-off task and confirmed it appeared
with no template link and reset the completed state; retired one template task and confirmed the
already-hired employee's checklist kept it unchanged while hiring a second employee produced a checklist
with only the two still-active tasks -- the core snapshot-vs-live-reference behavior this design exists
for. Confirmed a cashier-role token is refused for every write (template edits, complete, reopen, add).
Repeated the full check-off/reopen/add/"All done" sequence through the actual browser. Full verification
suite green: typecheck, lint, all contracts/db/pricing-spec tests (pglite and real Postgres, including
RLS), and a clean dashboard production build. All test data (two employees, three template tasks, their
checklists) removed afterward.

## Phase 2 — Invoice ingestion, part 5: review, "Add Variants", and commit

The sixth and final phase of the AI-assisted invoice-ingestion system: a human reviews every line,
resolves or splits it, and committing turns the result into a real purchase order and a real receipt --
the only place this whole system finally touches stock or money, and only because a person clicked
through it line by line.

- **`POST /v1/invoice-imports/:id/lines/:lineId/resolve`**: accept the AI's own suggestion or point a
  line at any other existing variant -- the same endpoint either way, since both are just "a human
  chose this variant." An optional `is_new_product` flag records that the variant didn't exist until
  the reviewer just created it (bookkeeping only; never gates anything). Re-resolving an already-matched
  or ignored line is allowed, so a reviewer can freely change their mind before committing.
- **`POST .../ignore`**: excludes a line from commit entirely (a duplicate, a subtotal that leaked
  through as a line, a discount row).
- **`POST .../split`** -- "Add Variants": the feature this whole project exists for. One line that
  bundles several flavors under a single vendor SKU ("50 boxes, Assorted Flavors") becomes several new
  sibling lines, each resolved to its own already-existing variant with its own slice of the original
  quantity. The quantities are required to add back up to the original line's exactly, or the request
  is rejected with the numbers spelled out. Creating the variant itself still happens on the product's
  own page (`CatalogService.addVariant`, from the first phase of this project) -- this only allocates a
  quantity across variants that already exist by the time it's submitted. Deliberately does **not**
  copy the parent line's own `vendor_sku` onto each child: a vendor's code on an assorted line names the
  bundle, not any one resulting variant, and copying it to every child would have made the
  `vendor_variants` upsert at commit overwrite itself down to whichever child happened to commit last --
  exactly the ambiguity this feature exists to resolve, not reintroduce.
- **`POST /v1/invoice-imports/:id/commit`**: requires an `Idempotency-Key`, same reason
  `purchase-orders/:id/receive` does. Refuses to run while any line is still `pending`, spelling out how
  many remain. No existing PO to reconcile against is the normal case in this vertical (per
  `docs/INTEGRATIONS.md`), so this synthesizes one from the resolved lines and receives against it in
  the same transaction, composing `PurchasingService`'s own `createPurchaseOrderTx`/
  `receivePurchaseOrderTx` -- exactly what that refactor, back in this project's second phase, was built
  for. Also **upserts `vendor_variants`** for every committed line that carries a vendor SKU, so the same
  vendor's next invoice needs less AI and less human correction -- a compounding return, not a one-shot
  tool. Attaching to a pre-existing purchase order (`invoice_imports.purchase_order_id` set ahead of
  time) is deliberately out of scope this pass -- nothing yet sets that column, and this vertical's
  vendors rarely place formal POs in the first place -- so `commit` throws a clear "not supported yet"
  rather than guessing at a line-to-line reconciliation.
- `invoice_imports.status` now advances itself to `reviewed` the moment the last `pending` line is
  resolved, ignored, or split, rather than requiring a separate "mark reviewed" click -- one less step,
  and the dashboard's Commit button reflects it immediately.
- `resolved_by`/`resolved_at` (existing, unused columns from the original staging migration) are now
  populated on every resolve/ignore/split, and `resolved_product_name`/`resolved_variant_name` join in
  for display, the same denormalization the AI suggestion columns already had.
- Dashboard: the invoice detail page gained per-line Resolve/Ignore controls (a variant picker
  defaulting to the AI's own suggestion, an "already created" checkbox, an Ignore button), a "Split into
  variants" link on ambiguous lines, a "Create new product" hand-off to `/catalog/new` (now accepting
  `description`/`brand`/`category` query params to prefill from `ai_suggested_*`) for anything with no
  catalog match, and a Commit button disabled until every line has been resolved, ignored, or split. A
  new split page lets a reviewer allocate one line's quantity across several already-existing variants.
  Once committed, the page becomes read-only and links to the resulting purchase order.

Verified against the real dev database and through the dashboard's own UI, twice -- once driving the
API directly and once clicking through the actual browser: parsed a synthetic invoice covering all four
matching tiers, then for the fully-resolved review: accepted an AI suggestion, overrode another to a
different variant and then reverted it back, ignored a line, and split the ambiguous "assorted flavors"
line into two real existing variants (rejecting an incorrect split first, to confirm the quantity-sum
check). Confirmed the import auto-advanced to `reviewed` the moment the last line was resolved.
Committed and confirmed: a new purchase order with exactly the right lines/quantities/costs, a receipt,
stock correctly incremented for every received variant (and correctly *not* incremented for the ignored
line), the PO's own total matching a hand-computed sum to the cent, `vendor_variants` upserted only for
the three lines that actually carried a vendor SKU (confirming the split children's own SKU was
correctly left blank), a second commit attempt cleanly refused as already-committed, and every
line-mutation endpoint refused once the import was committed. Along the way, found and fixed two real bugs
before they shipped: split children silently inheriting the parent's vendor SKU (see above), and a PO
reference doubling up its own prefix when a vendor's invoice number already had one (`INV-77042` becoming
`INV-INV-77042`). Full verification suite green: typecheck, lint, all contracts/db/pricing-spec tests
(pglite and real Postgres, including RLS), and a clean dashboard production build. All test data --
vendor, its `vendor_variants` rows, both invoice imports, both purchase orders and receipts, and the
inventory ledger entries they posted -- removed afterward, with stock levels confirmed restored to
their exact pre-test values.

## Phase 2 — Invoice ingestion, part 4: AI extraction and the matching cascade's AI tier

The fifth phase of the AI-assisted invoice-ingestion system: OpenAI reads the vendor invoice formats
that have no structure of their own to parse deterministically, and predicts the catalog metadata a
vendor's own invoice frequently leaves out or bundles together.

- **New `apps/api/src/platform/ai/` (`AiService`)**, the only place this API talks to OpenAI. Uses the
  installed `openai` SDK's Responses API (`client.responses.parse()`) with `zodTextFormat()` against
  Zod schemas in `packages/contracts/src/invoicing.ts`, so a Structured Outputs schema is defined once,
  the same "Zod is the one source of truth" rule every other boundary in this codebase already follows.
  A missing `OPENAI_API_KEY`/`OPENAI_MODEL` throws `provider_unavailable` (503) -- never a faked or
  empty result. The model name is read from `OPENAI_MODEL` only and never hardcoded.
- **`POST /v1/invoice-imports/:id/parse` now handles PDF and EDI**, not just CSV. A PDF's text is
  pulled with `pdf-parse`; an EDI/plain-text file is read as-is -- both are then "extract text, hand it
  to the model," not parallel pipelines. The model returns the same raw-line shape a parsed CSV already
  produces (quantity/unit cost/description/vendor SKU), plus, when present, the invoice's own vendor
  invoice number and grand total, now finally populating `invoice_imports.vendor_invoice_no`/
  `invoice_total_minor` (existing columns, unused until now). Image formats (PNG/JPG, or a scanned PDF)
  still aren't built -- that's vision, deliberately last. A missing AI configuration throws immediately,
  before anything is attempted; a bad file or a flaky model call instead lands the import on
  `status='failed'` with `parse_error` set, same as a malformed CSV always has.
- **`POST /v1/invoice-imports/:id/match` gained a 4th tier**, tried only for lines the barcode/vendor-
  SKU/trigram tiers already failed to place, and skipped entirely when no key is configured -- the first
  three tiers must keep working with zero OpenAI dependency. Fed each unmatched line's own top-5 trigram
  candidates (never the whole catalog) plus the org's real brand/category names, the model either picks
  the one candidate that's clearly correct (by index into that shortlist -- it can never invent a variant
  id) or predicts `ai_suggested_brand`/`ai_suggested_category`/`ai_suggested_product_description` when it
  can't. It also sets `is_ambiguous_multi_item` when a line's own text implies it bundles more than one
  distinct variant -- the "50 boxes of Torch THC Seltzer, Assorted Flavors" problem this whole system was
  built to solve -- as a signal for a human to split it with "Add Variants" rather than commit it as one
  wrong item.
- Dashboard: the invoice detail page now shows the AI's brand/category/description suggestion when
  there's no catalog match, and a visible warning on any line flagged as bundling multiple items.

Verified against the real dev database, a real OpenAI call, and through the dashboard's own UI: built a
synthetic PDF invoice (a hand-built minimal PDF, verified independently against the installed
`pdf-parse` first) covering all four tiers -- a real barcode, a vendor SKU seeded into `vendor_variants`
for a test vendor, a fuzzy-matchable description, and a deliberately ambiguous "assorted flavors" line --
and confirmed the extraction pulled every field correctly (including the invoice number and total,
correctly converted to minor units) and each line landed on the right tier, with the assorted-flavors
line correctly left unmatched, flagged ambiguous, and given a real brand/category/description guess. Ran
a second, lighter smoke test through the EDI/plain-text code path to confirm it also reaches the model
correctly. Confirmed the dashboard renders both the suggestion and the ambiguous-item warning. Full
verification suite green: typecheck, lint, all contracts/db/pricing-spec tests (pglite and real Postgres,
including RLS), and a clean dashboard production build (confirmed a first failed build attempt was
`.next` corruption from a concurrently running dev server, not a code defect, by stopping the dev server
and rebuilding clean). Cleaned up all test data (vendor, vendor_variants row, both invoice imports and
their lines) afterward. The "AI not configured" error path was verified by code inspection rather than a
live run, to avoid repeated dev-server restarts on top of this session's already-documented Windows
`--watch`/`EADDRINUSE` flakiness.

## Phase 2 — Invoice ingestion, part 3: the matching cascade

The fourth phase of the AI-assisted invoice-ingestion system: for each parsed line, try to identify
which catalog variant it's actually describing -- deterministically, for free, before any AI spend
enters the picture. Most well-formed invoices resolve entirely here.

- New `POST /v1/invoice-imports/:id/match`, tried in order for every line still without a suggestion:
  **(1)** an exact barcode match against `variant_barcodes` (in case the invoice's own "code" column
  is actually a UPC, not a vendor-specific SKU) -- confidence 1.0; **(2)** an exact match against
  this import's vendor's own `vendor_sku` in `vendor_variants` -- confidence 1.0, and the first time
  this table has ever been read or written anywhere in this codebase, exactly as dormant as
  `purchase_orders` was before this session started building real APIs behind these tables;
  **(3)** a fuzzy match on the description using `pg_trgm`'s `similarity()` against the catalog's own
  product/variant names (already enabled and indexed, unused for this purpose until now), only
  suggested above the same 0.3 threshold Postgres's own `similarity_threshold` GUC defaults to. A line
  nothing matches gets no suggestion at all -- not a low-confidence guess, which would be worse than
  no suggestion.
- **Only ever writes `ai_suggested_variant_id`/`ai_confidence`** -- never `resolved_variant_id`, never
  a status change. A line the cascade is completely certain about (an exact barcode) is still a
  suggestion, not a human's confirmation of it; review and commit are their own later step. Re-running
  match on an import only re-tries lines still missing a suggestion, so it's safe to call again after,
  say, adding a new `vendor_variants` mapping, without disturbing lines already resolved.
- Dashboard: a "Find matches" button on the invoice detail page, and a new "Suggested match" column
  on the line table showing the matched product/variant name and confidence percentage, or "no match
  yet."

Verified against the real dev database and through the dashboard's own UI: built a four-line test
invoice covering all three tiers plus a deliberately unmatched line (a real UPC for an exact barcode
hit, a `vendor_variants` row created for the test to prove that table's first real use, a
loosely-worded description for the fuzzy tier, and nonsense text expected to match nothing) and
confirmed each landed exactly where it should, with barcode/vendor-SKU hits at 100% confidence and
the fuzzy hit at a real, non-trivial similarity score; confirmed re-running match only reprocessed
the one still-unmatched line; confirmed a cashier-role token is refused for missing
`purchasing.create`; ran the same "50 Boxes Assorted Flavor"-style scenario through the actual browser
UI end to end (upload → parse → match) and confirmed the suggested match and confidence rendered
correctly. Cleaned up all test data (vendor, vendor_variants row, invoice import and its lines)
afterward.

## Phase 2 — Invoice ingestion, part 2: file upload, object storage, and CSV parsing

The third phase of the AI-assisted invoice-ingestion system: a real upload endpoint and a real
dashboard page, proving upload → object storage → the staging table round-trips correctly before any
AI dependency enters the picture. No catalog matching yet -- a CSV's own header row is enough to
separate quantity/cost/description/SKU without spending a token on it; PDF/image extraction and AI
matching are the next slices.

- **Object storage**: new `apps/api/src/platform/storage/` (`ObjectStorageService`), speaking the S3
  API against MinIO in development (already running in the dev stack, per `docs/INTEGRATIONS.md` --
  but with no bucket provisioned anywhere) and Cloudflare R2 in production later, same API. Creates
  its bucket on boot if missing, the same defensive-check-at-startup shape `DatabaseService` already
  uses for its own owner-role check.
- **Multipart upload**: `@fastify/multipart` registered in `main.ts`. The connection-level `bodyLimit`
  moved from 8 MiB to 20 MiB to fit an uploaded invoice (a scanned PDF or a phone photo) through the
  same ceiling every route shares -- Fastify checks this before any body parser runs, so a per-route
  override can't let a large upload through a smaller global one. The actual per-file cap is
  `@fastify/multipart`'s own 15 MiB `fileSize` limit, tighter than the connection ceiling around it.
- New `apps/api/src/modules/invoicing/` module: `POST /invoice-imports` (multipart: a file plus
  `store_id`/`vendor_id`, refused up front for any content type that isn't PDF/PNG/JPG/CSV/plain-text)
  stores the file and creates the staging row at `status='uploaded'`; `POST
  /invoice-imports/:id/parse` reads a CSV's header row to separate quantity/unit cost/description/
  vendor SKU (recognizing common header spellings -- `qty`, `unit cost`, `sku`, and their usual
  variants -- regardless of spaces, hyphens, or case) and inserts one staging line per row. A
  non-CSV file refuses parsing with a clear "not built yet" message rather than guessing; a malformed
  CSV lands the whole import on `status='failed'` with `parse_error` set -- a 200 a reviewer can act
  on, not a 500. No new permissions -- reuses `purchasing.view`/`purchasing.create`, the same gate a
  real purchase order already sits behind.
- Found and fixed a real parsing bug during verification: the header-matching only compared exact
  alias strings (`unit_cost`), so a real CSV's `"Unit Cost"` header (spaces, not underscores) matched
  nothing and silently left every line's cost blank. Fixed by normalizing both the CSV's own headers
  and the alias list to letters-and-digits-only before comparing, so `"Unit Cost"`, `"unit-cost"`, and
  `"unit_cost"` are recognized as the same header.
- `apps/dashboard/lib/api.ts`'s `apiFetch` gained a `FormData` carve-out -- it was unconditionally
  setting `Content-Type: application/json` on every request with a body, which silently breaks a
  multipart upload (the browser's own boundary header never gets attached). Dashboard:
  `/invoice-imports` (list), `/invoice-imports/new` (upload form, a plain `<input type="file">` --
  Next.js Server Actions handle a `File` field with no extra encoding setup), `/invoice-imports/[id]`
  (status, a "Parse this invoice" button, and the resulting line table once parsed).

Verified against the real dev database, real MinIO, and through the dashboard's own UI: confirmed the
bucket gets created on boot when none exists; uploaded a real CSV (including the "50 Boxes Assorted
Flavor" line this whole system exists to eventually handle) through the browser's own file input,
parsed it, and confirmed every line's quantity/cost/description/SKU came out right; confirmed an
unsupported file type is refused before storage, a non-CSV parse attempt fails clearly, and a
malformed CSV lands on `status='failed'` with a readable error instead of a 500; confirmed a
cashier-role token is refused for missing `purchasing.view`. Cleaned up all test data (database rows;
the handful of orphaned test objects left in the dev MinIO bucket are inert and harmless).

## Phase 2 — Invoice ingestion, part 1: staging schema and a purchasing refactor

Pure schema and a mechanical refactor, no new endpoint or dashboard page yet -- the second phase of
the AI-assisted invoice-ingestion system planned this session, laying the ground the rest of it
builds on.

- New migration `0014_invoice_imports.sql`: `invoice_imports` (one row per uploaded vendor invoice --
  file reference, vendor/store, parsed total, status through `uploaded → parsed → reviewed →
  committed`/`failed`) and `invoice_import_lines` (raw text, parsed quantity/cost/description/vendor
  SKU, and a full set of `ai_suggested_*`/`ai_confidence` columns). No new permissions -- an invoice
  import graduates into a real purchase order and reuses `purchasing.*` exactly as one already does.
  `split_from_line_id` gives "Add Variants" its lineage: a line a vendor described ambiguously (several
  flavors folded into one line item) flips to `status='split'` once a human resolves it, and each
  variant they create becomes a new sibling row pointing back at it.
  **The one rule carried through every column here**: AI only ever writes a `ai_suggested_*` or
  `ai_confidence` value. Nothing in this schema, and nothing planned on top of it, lets an extraction
  step create a product, change a price, or move stock by itself -- every real mutation happens
  because a human clicked a button that calls a real, permission-gated endpoint, with the suggestion
  as a starting point rather than an instruction.
- **Why a refactor had to come with it**: `po_receipt_lines.po_line_id` is a hard, `NOT NULL` foreign
  key to `purchase_order_lines(id)` -- there is no way to receive stock without a pre-existing PO
  line, which means committing an invoice that never had a formal PO (the common case for this
  vertical) has to *synthesize* one first, then receive against it, atomically. `PurchasingService`'s
  `createPurchaseOrder`/`receivePurchaseOrder` are now thin `withOrg` wrappers around new
  `createPurchaseOrderTx`/`receivePurchaseOrderTx` methods that take a transaction directly -- the
  same shape the file already used for its private `loadPurchaseOrder` helper -- so a future
  invoicing service can compose both inside one shared transaction instead of two separate ones that
  could partially fail. `receivePurchaseOrderTx` also gained optional `document_url`/
  `invoice_total_minor` parameters, finally giving `po_receipts`' two matching columns (present in
  the schema since the very first purchasing migration, written by nothing) a way to get populated.
  Zero behavior change to the two existing routes.

Verified against the real dev database: ran the exact same create-PO → partial-receive →
idempotent-replay sequence through the live API both immediately before and immediately after the
refactor (same vendor, same variant, same quantities) and confirmed structurally identical results at
every step -- same status transitions, same computed totals, same stock delta, same idempotency-replay
behavior -- before trusting anything to be built on top of it. Sanity-checked the new tables directly
against the live database (default status, the ambiguous-line flag, the confidence-range check
constraint rejecting an out-of-bounds value) since nothing calls them yet. Re-ran the full Postgres
and PGlite schema suites for the migration's updated counts.

## Phase 2 — Back office, eighth slice: add variants, bulk edit, and price groups

The first two phases of a much larger planned system: AI-assisted invoice ingestion (read a vendor's
PDF/PNG/JPG/CSV/EDI invoice, match its lines against the catalog, predict brand/category when the
invoice doesn't spell them out). That system's full design -- staging tables, a purchasing-service
refactor its commit step depends on, object storage, an OpenAI integration, a matching cascade -- is
written out in full for later rounds; this slice ships only the two pieces that stand on their own
with no new dependency: adding a variant to a product that already exists, bulk-editing several
products at once, and pricing a set of variants as one group. All three were explicit, standalone
asks on their own merits (an ambiguous invoice line -- "50 boxes assorted flavor" -- gets split into
real variants by hand, grouped so their price moves together later), not stubs for the larger system.

- **Add variant**: `POST /v1/catalog/products/:id/variants` fills a real gap -- until now the only
  way to add a variant was whole-product creation; an existing product had no way to gain a new
  flavor/size. Reuses `createVariantSchema`, the exact per-item shape whole-product creation already
  validated with. Recomputes the product's own `has_variants`/`variant_axes` from its variants
  afterward rather than trusting the caller -- the same invariant enforced at creation time, kept
  true independently since a 1-to-2-variant transition is exactly when it would otherwise go stale.
- **Bulk edit**: `PATCH /v1/catalog/products/bulk` finally gives `product.bulk_update` -- a permission
  that has existed, completely unused, since the very first migration -- a real implementation.
  Category, brand, tax category, and status, applied to a list of products in one transaction.
- **Price groups**: new `price_groups` table (`0013_price_groups.sql`) and a nullable
  `product_variants.price_group_id`. `POST /v1/catalog/variants/bulk-price` either forms a group from
  a list of variant ids and prices them together, or reprices an existing group by id with no need to
  re-select its members -- exactly "change their price later, all together." Reuses the same
  close-open `variant_prices` history logic a single variant's price change already used (extracted
  into one shared private method rather than duplicated). Repeating the same variant-id selection
  reuses its existing group instead of minting a new one and orphaning the last -- found and fixed
  during verification, when doing exactly that left stray `price_groups` rows behind.
- Found and fixed a real bug during verification, not code review: the bulk-price endpoint had no
  `store_id`, so it always priced the org-wide default scope -- but every price in this shop's seed
  data is store-specific, so the new price was silently shadowed by the old one and never actually
  showed up. Added `store_id` to `bulkPriceVariantsSchema` (mirroring `setVariantPriceSchema` exactly)
  and had the dashboard action pass the current store, the same as the single-variant price form
  already does.
- Dashboard: an "Add variant" form on the product detail page; a bulk-select column on the catalog
  list (one checkbox per row, plain HTML, no client JS -- `formData.getAll` reads the selection
  server-side) feeding two bulk-action forms, one for field edits and one for group pricing, using
  `<button formAction={...}>` so one shared selection can submit to either server action.

Verified against the real dev database and through the dashboard's own UI: added a variant to a
4-flavor product and confirmed `variant_axes`/`sort_order`/`is_default` all came out right; bulk-
edited two products' tax category and confirmed only those two changed; formed a price group from
three variants, repriced the *group* (not the individual variants) and confirmed all three moved
together while untouched variants on the same product didn't; confirmed repeating the same selection
reused the group instead of creating a new one. Re-ran the full Postgres and PGlite schema suites
after the migration to confirm the updated counts.

## Phase 2 — Back office, seventh slice: loyalty program settings

Configuration only, no engine. `docs/ARCHITECTURE.md`'s own entity diagram
names `loyalty_accounts`/`loyalty_transactions` as a full points-accrual system
(Phase 3: earning on completed sales, redemption at checkout, both of which
would touch the register app) -- but neither those tables nor anything else
loyalty-related existed anywhere in the schema, contracts, API, or Android
app before this slice. This is genuinely greenfield, unlike scheduling or
purchase orders which at least had a table or a clear shape already. Scoped
by the user to a points-based mechanic, settings only: this stores a
program's name, on/off switch, and rates. Nothing reads these numbers yet --
turning the program on does not change how a sale rings up today.

- New migration `0012_loyalty_settings.sql`: a `loyalty_settings` table, one
  row per org with `org_id` itself as the primary key (a business has one
  loyalty program's settings, not a list of them), plus `loyalty.view` and
  `loyalty.manage` permissions granted to owner/administrator/manager. Kept
  out of `organizations.settings` (the existing generic jsonb bucket) so the
  rates get real column types and `CHECK` constraints instead of living as
  unvalidated JSON. Updated the schema test suite's
  table/FK/enum/check/trigger counts for the new table.
- New `apps/api/src/modules/loyalty/` module: `GET /v1/loyalty/settings`
  (a no-op upsert creates the default row on first read, so there's nothing
  to provision ahead of time) and `PATCH /v1/loyalty/settings`
  (COALESCE-per-column, the same partial-update shape used everywhere else in
  this API). Found and fixed a real Postgres gotcha while testing the update
  endpoint live: `COALESCE($3, 1)` and `COALESCE($4, 100)` -- meant as
  defaults for the `numeric(10,2)` rate columns on a brand-new row -- made
  Postgres infer both parameters as plain `integer`, because a bare literal
  like `1` defaults to that type and a parameter's type has to agree across
  every use of it in one statement. Sending `"2.00"` for an inferred-integer
  parameter fails outright. Fixed by casting the literal defaults
  (`1::numeric`, `100::numeric`) rather than leaving Postgres to guess.
- Dashboard: `/loyalty`, a single settings form (active toggle, name, earn
  rate, redemption rate, optional minimum-redemption floor, optional
  expiration) with an explicit note that no accrual or redemption happens
  yet. Plain server-rendered form, this app's first checkbox input.

Verified against the real dev database and through the dashboard's own UI:
confirmed a fresh org gets sensible defaults on first load with no explicit
setup, saved full settings, made a partial update (toggling just the active
switch) and confirmed every other field stayed exactly as it was, confirmed
invalid input (a blank name, a malformed rate) was rejected before reaching
the database, and confirmed a cashier-role token is refused with
`loyalty.view` missing. Re-ran the full Postgres and PGlite schema suites
after the migration to confirm the updated counts are exactly right.

## Phase 2 — Back office, sixth slice: employee scheduling

A shift roster -- assign employees to upcoming shifts so everyone knows when
to work. Nothing in the schema answered "when is this employee supposed to
work" before this: `time_clock_entries` (0001, still unbuilt behind any API)
only records actual clock-in/out after the fact, and `cash_sessions` is a
register till session, not a work schedule. Scoped by the user to a roster
only -- time clock/timesheets stay deferred, and the register app is
untouched; scheduling is dashboard-only for now.

- New migration `0011_scheduling.sql`: a `shifts` table (`store_id`, `user_id`,
  `starts_at`, `ends_at`, `status` (`scheduled`/`cancelled`), `note`,
  `created_by`) plus two new permissions, `schedule.view` and
  `schedule.manage`, granted to owner/administrator/manager (both) and
  shift_lead (view only). Cancelling a shift is a status change, never a
  `DELETE` -- the same reason most other entities in this schema are
  soft-stated rather than erased -- which also means the table needs no
  `DELETE` grant at all; 0005's blanket `SELECT`/`INSERT`/`UPDATE` already
  covers everything it does. Overlap prevention (an employee can't be
  double-booked) is enforced in the service layer, not a database exclusion
  constraint -- that needs the `btree_gist` extension, which nothing else in
  this schema uses, for a UX nicety rather than a financial or inventory
  invariant. Updated `packages/db/test/migrate.test.mjs`'s schema-shape counts
  for the new table, enum, foreign keys, checks, and trigger.
- New `apps/api/src/modules/scheduling/` module: `GET /v1/scheduling/shifts`
  (a required date range, the same reasoning as the reports module's range
  queries -- an unbounded shift list isn't a useful roster view), `POST
  /v1/scheduling/shifts`, `PATCH /v1/scheduling/shifts/:id` (time and note
  only -- moving a shift to a different employee or store is a
  cancel-and-recreate, not an edit), and `POST
  /v1/scheduling/shifts/:id/cancel`.
- Dashboard: `/scheduling`, a week-at-a-time grid (employee rows × day
  columns, previous/next week navigation) with an add-shift form and a cancel
  button per shift. Built with the same plain server-rendered forms as every
  other page in this app -- no client components, no client-side date-picker
  library.

Verified against the real dev database and through the dashboard's own UI:
created a shift through the schedule grid, confirmed an overlapping shift for
the same employee was rejected with a clear error, rescheduled it, cancelled
it through the UI, and confirmed via direct SQL that the row stayed in the
table with `status = 'cancelled'` rather than disappearing. Re-ran the full
Postgres and PGlite schema suites after the migration to confirm the updated
table/foreign-key/enum/check/trigger counts are exactly right.

## Phase 2 — Back office, fifth slice: inventory management

Stock levels, manual adjustments, movement history, and a full purchase-order
and receiving workflow, added to the dashboard. Low-stock alerts and reorder
recommendations were scoped out of this pass: `stock_alerts` and
`reorder_recommendations` already exist as tables, but nothing computes an
average daily sales rate or a safety-stock number yet, and that's a forecasting
feature that deserves its own scoping conversation, not a byproduct of this one.

- The read and manual-adjustment inventory endpoints already existed
  (`GET /v1/inventory/levels`, `GET /v1/inventory/ledger`,
  `POST /v1/inventory/movements`) with no dashboard UI in front of them at all.
  Added `GET /v1/inventory/stock` and `GET /v1/inventory/stock/:variantId`,
  which start from `product_variants` rather than `inventory_levels` (left
  joining it) and join in product/variant/SKU names -- a variant with no stock
  history yet (just added to the catalog, never received) still shows up, at
  zero, instead of being invisible until its first movement.
- **Purchase orders and receiving are a real new backend module** --
  `apps/api/src/modules/purchasing/` -- since the tables (`purchase_orders`,
  `purchase_order_lines`, `po_receipts`, `po_receipt_lines`, `vendors`) existed
  in the schema from the start with no API in front of them. `line_total_minor`
  is computed as `round(quantity_ordered * unit_cost * 100)` in Postgres numeric
  arithmetic, never in a float. A PO starts at `submitted` rather than `draft`
  -- creating one here means it's been placed with a vendor, not saved
  mid-edit -- and `draft`/`confirmed`/`closed`/`cancelled` aren't wired to any
  UI action in this pass. Receiving posts one `receiving` movement per line
  through the same `InventoryRepository` every other stock change goes through
  (never touches `inventory_levels` directly), requires an `Idempotency-Key`
  for the same reason `POST /inventory/movements` does, and leaves the PO's own
  `subtotal_minor`/`total_minor` exactly as ordered even when a line's received
  cost differs -- that difference is recorded as `cost_changed` on the receipt
  line and `variance_flagged`/`variance_note` on the receipt, not silently
  folded into the PO's original total.
- Dashboard: `/inventory` (stock list), `/inventory/[variantId]` (current
  level, an adjustment form posting a signed quantity with a reason, and
  recent movement history), `/inventory/purchase-orders` (list),
  `/inventory/purchase-orders/new` (vendor picker with an inline "add a vendor"
  fallback when none exist yet, a fixed set of blank line rows rather than a
  client-side add-row control -- consistent with the rest of the app having no
  client components at all), `/inventory/purchase-orders/[id]` (lines,
  ordered/received quantities, and a receive form that defaults every quantity
  to blank rather than the remaining amount, so posting a receipt is always a
  deliberate choice per line, never an accidental full-receive from clicking
  submit without editing anything).
- Fixed a real bug found through browser verification, not code review: the
  purchase-orders list endpoint compared `po.status = $2` where `po.status` is
  the `po_status` enum and `$2` is bound as text -- Postgres has no `=` operator
  across those types regardless of the `$2 IS NULL OR` short-circuit, since SQL
  type-checks the whole expression before evaluating it. Fixed the same way an
  existing sales-list query already had it right: cast the column
  (`po.status::text = $2`), not the parameter.

Verified against the real dev database and through the dashboard's own UI:
posted a count-adjustment through the browser and confirmed the on-hand number
and ledger history updated correctly, then reverted it (a correction is a new
ledger row, never an edit, so the net-zero pair both stay in history, by
design). Created a vendor and a purchase order through the dashboard's own
forms, partially received it, confirmed stock rose by exactly the received
quantity and the status moved to `partial`, received the remainder at a
different unit cost, confirmed the status moved to `received`, the `total_minor`
stayed at the originally ordered amount, and `cost_changed`/`variance_flagged`
were set correctly on the second receipt -- then confirmed a replayed
Idempotency-Key did not double-post the stock. Cross-checked every step against
`GET /inventory/reconcile` (no drift) and direct SQL before removing the test
vendor, PO, and ledger rows.

## Phase 2 — Back office, fourth slice: reports and dashboards

The foundation slice's home page only ever showed "today" -- no date range, no
breakdown beyond a flat list of the last 20 sales. This slice adds a real
`/reports` page: any custom date range (plus Today/Last 7 days/Last 30 days
presets), a daily gross-sales trend chart, and three breakdowns -- top
products (by revenue, not unit count, so a $1 item selling 500 units doesn't
outrank the case that pays the rent), by cashier, and by payment method.
CSV export was scoped out of this pass to keep it focused on in-browser
reporting; the underlying queries are already row-level, so exporting them is
a fast follow-up whenever it's wanted.

- New `packages/contracts/src/reports.ts` additions: `reportRangeQuerySchema`
  (`store_id?`, `from`, `to` -- required, unlike the existing summary query's
  optional range, because a trend or breakdown with no bound is not a useful
  report), and one schema each for a trend point, a top-product row, a
  by-cashier row, and a by-payment-method row (reusing the existing
  `paymentMethod` enum from `sales.ts` rather than redeclaring it).
- Four new `GET /v1/reports/sales/*` endpoints (`trend`, `top-products`,
  `by-cashier`, `by-payment-method`), all gated on the same `report.sales`
  permission the existing summary endpoint uses, all following its exact
  shape: `DatabaseService.withOrg` for RLS-scoped queries, money summed as
  `bigint`-safe strings, and the `($n::type IS NULL OR col = $n)` optional-filter
  idiom instead of building SQL by hand. Top products joins `sale_lines` through
  `product_variants`/`products`/`categories` (a real materialized-path table,
  not a text field); by-payment-method joins `payments` to `sales` and requires
  `status = 'captured'` on a real sale (`sale_id IS NOT NULL`) so a pending,
  failed, or refund-side payment doesn't get counted as tendered revenue.
- Dashboard: `/reports`, added to the nav. A plain `<form method="get">` date
  range plus preset links -- no client-side state, consistent with the rest of
  the app's server-rendered-forms approach. The trend chart is a small inline
  SVG bar chart rather than a charting library dependency, since it's one bar
  per day with no interaction beyond a hover tooltip.

Verified against the real dev database: the four new endpoints' totals
cross-checked exactly against each other for the same range (trend, by-cashier,
and by-payment-method gross all summed to the same $637.83), matching what a
direct SQL aggregate over the seeded sales confirmed independently. Verified
through the dashboard's own UI in a browser: the default 7-day range, the
"Today" preset (correctly empty, matching the home page's own "today" card),
and a custom range submitted through the date-picker form all rendered the
right numbers.

## Phase 2 — Back office, third slice: employee & permissions management

Browse, edit, invite, and manage roles for employees from the dashboard -- the third sequenced slice.
Scoped by the user to cover everything except editing what a role itself grants: `roles.org_id IS
NULL` marks a system role (cashier, manager, owner, ...) as a platform default shared by every
organization, so letting one org's admin edit what one of those grants would be a global change
wearing a per-org settings screen. That stays out of scope; assigning and removing an employee's
role *memberships* does not.

- New `apps/api/src/modules/employees/` module: `GET /v1/employees` (list with assigned role
  names), `GET /v1/employees/roles` (for pickers -- registered ahead of `:id` so Nest doesn't match
  "roles" as an employee id), `GET /v1/employees/:id`, `PATCH /v1/employees/:id`
  (COALESCE-per-column, same partial-update shape as customers and catalog), `POST
  /v1/employees/:id/pin` (upserts `employee_pins`, resetting the failed-attempt lockout), `POST
  /v1/employees/:id/roles` and `DELETE /v1/employees/:id/roles/:userRoleId` (assign/remove one role
  membership), and `POST /v1/employees` to invite a brand-new employee in one transaction (user row,
  one role assignment, optional PIN and/or dashboard password). All gated on the existing
  `employee.view`/`employee.manage` permissions. Reuses the `phone`-or-`email` contactable rule
  already established for customers, as its own `users_contactable` check constraint.
- New `packages/contracts/src/employees.ts`. While wiring it up, found that `identity.ts` already
  had an unused, incorrect `roleSchema` (wrong field names -- `code`/`is_platform` instead of the
  real `key`/`is_system`) plus an unused, incorrect `userSchema`/`createUserSchema` (missing fields,
  wrong status enum) that didn't match the live schema and weren't referenced anywhere in the API or
  the Android app. Replaced them with one corrected `roleSchema` rather than routing around the
  collision, so `identity.ts` stops being a source of wrong information about what a role or a user
  actually looks like.
- Dashboard: `/employees` (list), `/employees/[id]` (own-field edit, role list with remove buttons,
  an add-role picker that excludes roles already held, and a reset-PIN form), `/employees/new`
  (invite form: name, contact, one initial role, optional PIN/password).
- Found and fixed a real bug during browser verification, not just in code review:
  `apps/dashboard/lib/api.ts`'s fetch wrapper sent `Content-Type: application/json` on every
  request, including the no-body `DELETE` that removing a role assignment is -- Fastify refuses that
  combination outright. Confirmed via direct SQL that the failed request never reached the database
  (no partial state), fixed the header to only be sent when there's actually a body, then re-ran the
  same removal through the browser and confirmed it now persists.

Verified end to end against the real dev database and through the dashboard's own UI in a browser:
added and then removed a role from a seeded manager (confirming the DELETE bug above and its fix),
and invited a brand-new employee through the "Add employee" form, confirming their user row, role
assignment, and hashed PIN all landed correctly before removing the test data.

## Phase 2 — Back office, second slice: catalog management

Browse, edit, and add products from the dashboard -- the next sequenced slice after the back
office's foundation. `updateProductSchema` and the full `productSchema` (with variants nested) had
existed in contracts since the beginning with no endpoint behind them; this is what finally calls
them.

- New `GET /v1/catalog/products/:id` (one product, every variant, each variant's barcodes and its
  current price at a given store -- store-specific beats org default, the same precedence
  `scan`/`search` already used), `PATCH /v1/catalog/products/:id` and `PATCH
  /v1/catalog/variants/:id` (both `product.update`, COALESCE-per-column partial updates, the same
  shape as the customer endpoints from the previous slice), and `GET /v1/catalog/brands` /
  `GET /v1/catalog/tax-categories` for the edit form's dropdowns.
- **Price is its own action, never a field edit.** `POST /v1/catalog/variants/:id/price` inserts a
  new `variant_prices` row and closes whatever was open before it, in that order, inside one
  transaction -- because `variant_prices_open_regular_key` models a price as a history, not a
  mutable column, and a plain `UPDATE` would erase the fact that a different price ever existed.
  `updateVariantSchema` deliberately excludes price (and SKU, and barcodes) for the same reason.
- Dashboard: `/catalog` (search, reusing the register's own search endpoint), `/catalog/[id]`
  (product fields, and one form per variant for its own fields plus a separate price-change form),
  `/catalog/new` (single-variant product creation, reusing `POST /catalog/products` -- which
  already existed and needed no changes). Multi-variant products (several flavors of one item) can't
  be created from the dashboard yet; adding a variant to an existing product is a natural next
  addition, not built this round.
- This app has no store switcher yet: `lib/store.ts` reads the org's first store and uses it
  everywhere pricing needs one. Fine while the shop this ships to first has exactly one -- add a
  real selector before a second store exists.

Verified end to end against the real dev database: browsed and opened the seeded "Geek Bar Pulse X"
product, changed one variant's price and confirmed the old `variant_prices` row closed at the exact
instant the new one opened (no gap, no overlap) with a direct SQL query, reverted it, then created a
brand-new single-variant product end to end and confirmed its product/variant/price/barcode rows
all landed correctly before removing the test data.

## Phase 2 — Back office, first slice: foundation, sales dashboard, customers

A back-office web app has never existed in this repo -- only the register and the API. This is the
first slice: a working `apps/dashboard` (Next.js 15 App Router) reachable from a browser, with real
auth, a sales overview, and full customer management. Deliberately not in this slice: catalog
editing, employee/permissions management, EDI, an AI catalog manager, and loyalty settings -- each
is sequenced for its own build, not stubbed out now.

- **Auth is backend-for-frontend, not tokens in browser JS.** The dashboard's own Server Actions and
  Middleware call the API's existing `/v1/auth/login`/`/refresh`/`/logout` -- unchanged, the same
  endpoints the register uses -- and store both tokens as httpOnly cookies the client never sees.
  `middleware.ts` decodes the access token's own `exp` (no signature check needed here; the API
  verifies that on every real request) and refreshes proactively on every matched request, since
  Next.js only allows writing a cookie from Middleware, a Server Action, or a Route Handler -- never
  from a Server Component's render, which is where the actual page data fetching happens.
- **Reporting, additive**: `saleQuerySchema` gained `from`/`to` (the columns already existed;
  `SalesService.list` never applied them until now), and a new `apps/api/src/modules/reports/`
  module adds `GET /v1/reports/sales/summary` (count, gross, tax, average ticket over a range, voids
  excluded) -- gated on the `report.sales` permission that already existed for the sales list.
- **Customers, extended for browsing**: `customerSearchSchema`'s "must supply phone or q" rule
  existed for the register's live-lookup use case; the back office needed to list with no filter at
  all, so the rule is dropped rather than replaced (the register's own call sites are unaffected --
  they always pass one). `q` now also matches phone as a fragment, not just an exact match, since an
  admin's one search box shouldn't need to know the register's phone/name distinction. New
  `PATCH /v1/customers/:id` (`customer.manage`, same gate as create) updates only the fields sent --
  an omitted field keeps its existing value by `COALESCE`, which is also why there's no repeated
  "needs a phone or an email" check on update: this endpoint has no way to null one out.

Verified end to end against the real dev database, not just typechecked: signed in as a seeded
manager, the dashboard's "today" totals came back zero (correctly -- all seeded sales are from the
day before) while an unfiltered range matched a direct SQL aggregate exactly; created, searched by
partial phone, opened, and edited a customer, with the change persisting after a fresh fetch; an
unauthenticated request to a protected route received a 307 to `/login`; and the `auth_sessions`
table's own rotation history showed the middleware's silent refresh firing correctly, unprompted,
several times over the course of testing.

## Phase 2 — Customer attachment

Customers have had a table, a `sale.customer_id` foreign key and `customer.view`/`customer.manage` permissions since the schema's first migration, and the register's own `Cart.customerId`/`withCustomer` since early in the domain layer — nothing on either side ever called it.

Customers are deliberately **not** part of the catalog snapshot or the incremental change feed: caching the customer table on a terminal that can be stolen is a privacy problem with no operational payoff. A register looks a customer up live instead, which makes this the one place the register talks to a fifth kind of endpoint beyond sign in, refresh, pull, and push.

- New `packages/contracts/src/customers.ts` and `apps/api/src/modules/customers/` (search by exact phone or a name/email fragment; get by id; create, gated on `customer.manage` — separate from the `customer.view` search needs, the same split price override draws between reading a permission and reaching for a manager). A customer needs a phone or an email to be reachable, enforced by both the schema's own `customers_contactable` check and the contract's zod refinement.
- `SnapPosApi.searchCustomers`/`getCustomer`/`createCustomer` plus a new `CustomerRepository` in `core-sync` — every call reaches the network, with no local fallback; a register with no signal simply cannot attach a customer that moment, but the sale rings up fine without one either way.
- `RegisterViewModel.searchCustomers`/`attachCustomer`/`detachCustomer`/`createCustomer`, and a new `CustomerDialog`: one search field classifies its own input (phone-shaped digits vs. a name/email fragment) rather than asking the cashier to pick a mode. The existing "Walk-in customer" subtitle in `CartPanel` became the entry point — made clickable in place, rather than adding a new control, since the compact register layout has no vertical room to spare for one.
- A resumed held sale re-resolves the customer's name from its id with a best-effort lookup, since the id survives a hold (it is a plain field on the cart) but a name never does — nothing is ever cached.
- The receipt now names the attached customer, by name only — never a phone or email, the same restraint the schema itself uses.
- `CustomerDialog`'s own content column needed `verticalScroll`: Material3's `AlertDialog` clips overflow rather than scrolling it, and this dialog's four-field creation form did not fit the primary target device's short landscape screen. Third time this exact failure mode has shown up this phase (`CartPanel`'s header, `SplitPaymentDialog`'s keypad, now this) — worth treating as a standing risk on every new dialog aimed at this device rather than a one-off.

Verified end to end on the physical target device signed in as a seeded cashier: searching by name and by phone both find a customer already known to the server; attaching one updates the header and prints on the receipt; a held sale resumed later re-shows the same name; a cashier without `customer.manage` is refused when creating a new customer, with the refusal visible on screen, not just in a log.

## Phase 2 — Manager-authorized price override

Wired up `Cart.overridePrice`, which had existed in the domain layer with no
caller. Unlike a line discount, a cashier does not hold `sale.price_override`
by default, so this always goes through the same manager PIN prompt as a
refund or a void -- never a plain permission check on the signed-in cashier,
which would defeat the point of the permission existing.

- `RegisterViewModel.requestPriceOverride` stores the pending line, new price
  and reason and raises the same `ApprovalDialog` refunds and voids use, now
  also mounted at the selling stage rather than only inside the refund flow.
- On approval, `shift.approve("sale.price_override", pin)` names the manager;
  `Cart.overridePrice` re-runs `CartLine`'s own invariants on `copy()`, so a
  negative price is refused by the domain regardless of what the dialog let
  through -- checked twice, not trusted once.
- Added the missing negative-price-override test alongside the existing
  positive-path coverage: a price override cannot make a line negative, and a
  price of exactly zero is accepted as a legitimate discretionary give-away.

Not yet verified on hardware -- no device was connected while this was built.

## Phase 2 — Modern register workspace

- Reworked the Android register into a high-contrast, touch-first workspace with a persistent operational header, prominent scanner/search field, category rail, product cards, current-sale context, and responsive cart.
- Added a real permission-checked line-discount flow with bounded amounts, required reason codes, domain invariants, and automated over-discount coverage.
- Added selected-line actions, cart clearing with confirmation, clearer empty-cart guidance, receipt/return/shift shortcuts, and compact quantity controls.
- On short landscape devices, age verification becomes the blocking primary action so the cart line, totals, and compliance requirement remain visible together.
- Redesigned employee unlock with profile cards, secure PIN panel, clear register readiness state, and a fully visible landscape keypad.
- Added `docs/POS_DESIGN_SYSTEM.md` to keep future POS screens consistent and prevent non-functional controls from entering the cashier workflow.

### Fixed

- **The unlock PIN pad's backspace key was unreachable.** Its icon rendered as a sibling of the clickable box rather than inside it, so the visible glyph sat outside the tappable region and had no click handler of its own -- tapping it did nothing, and the actual clickable area was a blank square to its left. Caught by reading the layout rather than trusting that it compiled; moved the icon into the same `Box` as the other keys, matching the working pattern in `DrawerScreen.SimpleKeypad`. Not yet re-verified on hardware -- no device was connected when this was found.

## Phase 2 — Atomic incremental catalog projections

- `GET /v1/sync/catalog` now accepts the register's last cursor and returns only
  affected projections through `included_scopes`. A price-only edit no longer
  retransfers products, barcodes, inventory, or the employee roster.
- Change detection, projection reads, and cursor selection share one PostgreSQL
  transaction, closing the cross-scope race created by separate check/fetch
  requests.
- Android replaces only named Room projections and advances its cursor in the
  same local transaction. Deletions are reconciled by absence, and a crash
  cannot leave a new cursor over old data.
- A cursor ahead of a restored server forces a complete bootstrap. Unknown
  projection scopes fall back to the complete snapshot.
- End-to-end coverage proves unchanged pulls transfer nothing, price-only pulls
  remain price-only, cursors stay stable, and reset recovery bootstraps.

## Phase 2 — One pricing specification, two engines

The backend and offline register must calculate identical amounts even though
one is TypeScript and the other Kotlin. A language-neutral fixture suite now
makes that agreement a required CI property instead of an architectural promise.

### Added

- **51 shared pricing cases** covering half-up rounding, negative sale/refund
  amounts, exact allocation, deterministic remainder placement, weighted
  allocation and six-decimal catalog costs. Every value is encoded as a string
  so the specification never depends on a language's JSON-number behavior.
- **Two independent runners.** Node executes the TypeScript money engine and a
  pure JVM test executes Kotlin against the same four JSON files. CI runs both
  in one `Pricing conformance (both engines)` job on every commit.
- **Vacuous-pass guards and mutation proof.** Missing fixtures, empty files and
  an unexpectedly small case set fail. Removing Kotlin half-up rounding was
  verified to fail on the exact named fixture that distinguishes it from
  truncation.

### Fixed

- Kotlin rate and weighted-allocation intermediates now use `BigInteger` before
  converting the final posted amount back to `Long`. A valid final amount can
  otherwise overflow an intermediate multiplication and fail only on one side
  of synchronization.
- Both cost parsers now enforce PostgreSQL's `numeric(14,6)` fractional scale
  instead of accepting precision the database cannot preserve.
- Kotlin money formatting now handles `Long.MIN_VALUE`; negating that value in
  `Long` overflows back to itself.

## Phase 2 — The incremental change feed, populated

`change_log`, its cursor index, `sync_changes_watermark()` and
`GET /v1/sync/changes` all existed. **Nothing ever wrote a row**, so the feed was
a skeleton: a register asking what changed was always told "nothing", and the
only way to learn about a price change was to pull the whole catalog again.

### Added

- **Migration 0008** — one parameterised `log_change()` trigger function and
  twelve triggers, on the tables a register actually replicates. One function
  rather than twelve near-identical ones, because those drift, and the way they
  drift is that one quietly stops logging and a till stops hearing about a
  category nobody can explain.
- **Ignored columns.** `updated_at` is stripped on every table, because a
  `_touch` trigger bumps it on every update — leaving it in means no two
  versions of a row ever compare equal, the suppression never fires, and the
  hash changes when the content did not. `users.last_login_at` is stripped too:
  every sign-in writes it, so without this every sign-in marked the whole
  `employees` scope dirty for every register in the store. A false positive on
  the most frequent write in the system, on the very feed that exists to avoid
  pointless refetching.
- **`inventory_levels` is deliberately not tracked.** It changes on every line
  of every sale at every register, so the feed would be almost entirely
  inventory churn — and the register treats stock as advisory, shown so a
  cashier can answer "have we got more", explicitly not gating a sale. Stock
  arrives with the bootstrap snapshot instead.

- **The register asks before it pulls.** `CatalogSync` now calls the feed with
  `limit=1` and returns immediately when nothing changed, transferring nothing.
  A failed feed read falls through to a full pull rather than concluding the
  catalog is current. Incremental *detection*, not yet incremental
  *application*: when something has changed the register still pulls the whole
  snapshot, because per-entity fetching needs endpoints that return a row in the
  register's projection shape and those do not exist. Verified on a Galaxy S22
  Ultra across both branches and back to idle.

### Fixed

- **The change feed returned its pages in the wrong order.** The query was
  `SELECT id::text ... ORDER BY id`, and a bare `ORDER BY id` binds to the
  *output* column — the text cast — ahead of the table's bigint. So the cursor
  sorted lexicographically: 1, 10, 11, … 19, 2, 20. With a `LIMIT` that returns
  an arbitrary subset, and a register paging with `since` would skip changes
  **permanently** — a price change or a new product that no till ever hears
  about, with nothing anywhere reporting a fault. Exactly the class of silent
  loss the watermark exists to prevent, reintroduced one line below it.
  `ORDER BY change_log.id` cannot bind to an output alias.

  This was invisible while `change_log` was empty, and surfaced the moment the
  triggers gave it more than nine rows to order.

## Phase 2 — Upload the moment the network returns

### Added

- **`ConnectivityWatcher`** — a default-network callback that calls `syncNow`
  when the network becomes usable. `VALIDATED`, not merely connected: a register
  walking back into range is associated-but-unproven for a second or two, and
  uploading into that state burns a retry. Only a transition into usable fires
  it, because wifi-to-mobile handover and radio re-association produce callbacks
  while the register was online throughout.

  It exists because **a satisfied constraint does not shorten a backoff**.
  WorkManager releases constraint-blocked work as soon as connectivity returns,
  so a register that was merely offline would have coped; a worker that already
  failed and was rescheduled carries a timing delay that connectivity does not
  clear, and `syncNow`'s `REPLACE` cancels it.

  It does **not** cover a healthy network with a dead server — nothing changes
  from Android's point of view, so no callback fires. That falls to the next
  sale or the periodic job, and closing it would mean polling a server that is
  already failing to answer.

  Verified on a Galaxy S22 Ultra: airplane mode on, sale queued, airplane mode
  off, and the log reads `network usable again; draining the outbox` followed by
  `upload: 1 accepted, 0 duplicate, 0 rejected, 0 dead, 0 left` — on the server
  within twelve seconds, landing exactly once, ledger in agreement, no dead
  letters.

## Phase 2 — Receipts

A receipt is described, not formatted: `ReceiptRenderer` produces an abstract
`ReceiptDocument` and whatever consumes it decides the width. The same document
prints to 58mm, to 80mm, and to the screen, which is what stops a preview
drifting from the paper a customer is holding. 14 tests, all pure Kotlin.

### Added

- **`ReceiptDocument`** — text, label/amount rows, sold items, separators and a
  machine readable receipt number. No column widths, no printer commands.
- **`TextReceipt`** — the rasterizer. Paper width is a value (`Mm58` = 32
  columns, `Mm80` = 48), not a second template. Amounts are flush to the last
  column so a receipt can be checked by running a finger down the right edge,
  long product names wrap on word boundaries, and a label that would crowd the
  amount is truncated rather than wrapped — the amount is the part that has to
  survive.
- **`PrinterProvider`** in `hardware-api`, interfaces only. Every method
  reports rather than throws: the money has changed hands by the time a receipt
  is produced, so a printer out of paper must never be able to fail a sale.
- **The receipt on screen**, rendered through the same `TextReceipt` a printer
  would use, reachable from the register once there is a sale to show. It says
  "No printer configured" plainly — a Print button that silently does nothing
  is worse than no button, because a cashier presses it and hands the customer
  nothing.

### Compliance

An age restricted sale records **that the check happened** — "Age 21+ ID
verified" — and nothing else. No date of birth, no licence number, no name. A
receipt ends up in a bin behind the counter, and identity data on it is a breach
made of paper. There is a test asserting the rendered receipt contains none of
those words.

### Not built

The ESC/POS driver. There is no printer here to verify one against, and an
unverifiable driver that looks finished is worse than an absent one. The
interface it plugs into is done and the document it consumes is tested.

Store address, phone and return policy are shop configuration that does not
exist yet, so the receipt omits them rather than inventing them.

## Phase 2 — A scan could be silently dropped

### Fixed

- **Scanning fast lost items from the cart.** Measured on a Galaxy S22 Ultra:
  10 scans at 2.5s intervals added 10 items, but 10 scans back to back added
  **7**, and the same barcodes delivered as raw key events added **2**. A
  customer charged for one of the two things in their hand, on the one code path
  a shop uses thousands of times a day.

  The cause is a lost update that reads as atomic and is not:

  ```kotlin
  _state.value = _state.value.copy(tiles = catalog.byCategory(...))
  ```

  Kotlin evaluates the receiver first, then suspends on the Room query, then
  copies the state it captured *before* the suspension. Anything written while
  it was suspended is discarded. Clearing the scan field calls this on every
  submit, so two scans in quick succession overlapped: the search started by the
  first read the cart, suspended, and wrote the pre-scan cart back over the item
  the second had just added.

  Both occurrences now resolve the query into a local before touching state.
  Re-measured on the same device at the same speed: **10 of 10 and 20 of 20**,
  no loss on either input path.

  Worth stating plainly: this never reproduced while driving the register by
  hand, because a person cannot scan fast enough to overlap two database reads.
  It only appeared under machine-speed input, and it is exactly the kind of
  defect that survives to production as "the count is off again".

## Phase 2 — Voids through sync

A void composed at the counter, authorised by a manager PIN, delivered through
the sync batch under the cashier's token. 93 end to end checks pass.

Verified on a Galaxy S22 Ultra: the 2 to 3 migration against existing data, the
cashier's PIN refused, a manager's accepted, and the void landing server side
with stock restored, the ledger agreeing and the drawer netted to zero.

### Added

- **`sale_void` as a sync entity.** A void is its own entity rather than a
  mutation of the sale it voids: sales are append only on both sides, and an
  upload that edited a row already delivered would have no idempotency key of
  its own to make the retry safe. Authority is the approver's, exactly as for a
  refund.
- **`SalesService.intakeVoid`** — idempotent on the sale's own status, so a
  redelivery reports `duplicate` and nothing is restocked twice. `voidInTx` is
  shared with the HTTP route so both reverse stock through the same code; two
  implementations of "put the sale's stock back" would drift, and the direction
  they drift in is a count that is quietly wrong.
- **Room schema 3 and `MIGRATION_2_3`** — `voidedAtMillis`, `voidedBy` and
  `voidReason` on `sales`. Nullable rather than defaulted: a default would claim
  every historical sale had been voided by nobody at the epoch.
- **`VoidRepository`** — the same two guards as the server, checked before
  anything is written so a refusal leaves no trace, plus the drawer reversal.
  The void action is offered only while the whole sale is still returnable.
- **A voided receipt says so.** Looking one up for a refund used to answer "no
  sale on this register with receipt HH01-R1-7", which is untrue — the sale is
  there, it was voided — and sends a cashier looking for a receipt they are
  holding.
- **`RetryableIntakeError`** — a void whose sale has not arrived yet waits
  instead of being rejected. Entities are ordered inside a batch but not across
  batches, so a sale whose upload failed while its void succeeded is a normal
  sequence. Rejecting would dead letter the void after five attempts and leave a
  sale standing that a manager already voided at the counter.

### Fixed

- **Voiding a cash sale left the money in the drawer.** The void reversed stock
  but never the tender, so the drawer was expected to hold cash that had been
  handed back — every voided cash sale read **over** by its own amount at close.
  That is worse than a missing feature: over and short are the only signal a
  manager has, and a cashier who voided a sale and pocketed the notes produced a
  drawer that balanced perfectly. Captured cash now reverses into the same
  session, under an id derived from the payment being reversed so a replayed
  void cannot take it out twice. Only cash reverses — a card void has to go back
  through the processor, and no provider is integrated yet. A void of a sale
  from a closed shift is refused, with the remedy named: refund it, so the money
  leaves today's drawer.

## Phase 2 — Refunds on the device

A partial refund against a receipt, approved by a manager PIN on the register,
uploading and restocking server side. Verified on a Galaxy S22 Ultra. 83 end to
end checks pass.

### Added

- **Room schema v2 and `MIGRATION_1_2`** — `refunds`, `refund_lines`, and
  `quantityRefunded` on `sale_lines`. Hand written and exercised against a
  device that already held v1 data. `fallbackToDestructiveMigration` stays off:
  on a register, dropping the database to resolve a version mismatch deletes
  completed sales that have not uploaded yet.
- **`RefundRepository`, `RefundsDao`, `RefundScreen`, `ApprovalDialog`** — the
  on device flow. Over-refund is refused before anything is written, so a
  refusal leaves no trace. Tax is divided back out per unit so a partial refund
  returns a proportional share.
- **Delegated approval on the sync route** — `APPROVER_FIELD_BY_ENTITY`. A
  refund's authority comes from the user its payload names in `approved_by`,
  looked up live and required to be active and to hold `refund.create`.

### Fixed

- **A manager approved refund could never upload.** The register uploads under
  the cashier's token and a cashier does not hold `refund.create`, so every
  refund taken at the counter would have been rejected as non-retryable and
  dead lettered. Checking the uploader's permissions is wrong for an action
  someone else authorised; checking the named approver's is both correct and
  stricter, because the device's claim about who approved is now verified
  rather than trusted. A register naming the cashier themselves is refused
  exactly like one naming nobody.
- **The approval button was off screen.** The refund's right hand column was a
  fixed `Column` taller than the ~384dp a phone has in landscape, so the button
  was clipped and the refund could not be completed on the only form factor the
  register runs on. The reason list scrolls; the amount and the button are
  pinned.
- **`syncNow` used `APPEND_OR_REPLACE`,** chaining each sale behind the one
  before it. A single entity in exponential backoff then held up every sale rung
  after it — head of line blocking on the one path that must never stall.
  `REPLACE` loses nothing, because the worker drains the whole outbox rather
  than one entity, and it clears a stuck backoff the moment the next sale is
  rung.
- **The end to end suite reset the development database.** It drops and
  recreates whatever it points at, and pointed at `snappos` it also wiped the
  registers a physical device was provisioned against — leaving that device with
  queued sales referencing store, register and variant ids that no longer
  existed and no way back. It now uses `snappos_e2e`.
- **The approval dialog showed a stale refusal** while the next PIN was being
  typed, and the keypad shifted under the manager's finger as the message
  appeared and went. The message clears on the first digit and its slot is a
  fixed height. Reserving that height cost the dialog its bottom keypad row on
  a phone in landscape — taking backspace and clear with it, so a mistyped
  digit could only be resolved by submitting it and failing — so the dialog's
  padding came down to pay for it.
- **The bootstrap snapshot answered a bad request with an empty catalog.**
  `GET /v1/sync/catalog` took `store_id` as an unvalidated query parameter, so
  omitting it — or naming a store in another organization, which RLS makes
  invisible — returned **200** with no staff, no prices and no stock. A
  register cannot tell that apart from a store that genuinely has none: it
  shows "no staff on this register yet", cannot be unlocked, and nothing
  anywhere says why. `store_id` is now required and the store must exist in the
  caller's organization; otherwise 400 or 404.
- **An empty roster gave a guess instead of a reason.** "No staff on this
  register yet. Connect to the server to set it up." reads as a diagnosis but
  was really the most likely of four different situations, and the advice is
  wrong for three of them. The unlock screen now distinguishes not provisioned,
  never synced, synced-but-the-server-named-nobody, and every-employee-inactive,
  from durable state — the catalog cursor and a count of employee rows
  regardless of status. A till that will not open is the worst failure this
  product has, and whoever is standing at it has to be able to say something
  useful down the phone.

### Known limits

- Receipt lookup is local to the register that rang the sale.
- The refund tender is always cash. A card refund has to go back to the card,
  and no payment provider is integrated yet.

## Phase 1 — API vertical slice

Auth, tenancy, RBAC, idempotency, catalog, inventory and sync, working end to end
against real Postgres. 34 end to end checks pass.

### Added

- **`apps/api`** — NestJS on Fastify. Platform layer (database, auth, RBAC,
  idempotency, errors, validation) plus catalog, inventory, sync and org modules.
- **`packages/contracts`** — Zod schemas as the single source of truth, with the
  `Money` type. 24 tests.
- **Migration 0006** — `product.view`, `sync.upload`, `sync.download`.
- **Migration 0007** — `auth_lookup_user` and `auth_lookup_session`.
- **`InventoryRepository`** — the only code permitted to write `inventory_levels`,
  always in the same transaction as a ledger entry. `reconcile()` proves the
  projection still equals `sum(delta)`.
- **End to end suite** — resets the database, starts the API, exercises the real
  HTTP surface.

### Fixed

- **Login could not work under RLS.** The policy denies when `app.org_id` is
  unset, and the organization is unknown until the user is found. Resolved with
  two narrow `SECURITY DEFINER` lookups (migration 0007) rather than by weakening
  the policy or connecting as a role that bypasses RLS. Fixed column lists,
  `search_path` pinned, `EXECUTE` revoked from `PUBLIC`.
- **Every validation failure returned 500.** The API compiles to CommonJS and
  `@snappos/contracts` is ESM, so each half loads a different copy of zod and
  `instanceof ZodError` is false across that boundary, despite npm installing
  exactly one version. The validation pipe now converts at the boundary and the
  filter duck types as a fallback.
- **Deterministic ledger ids did not actually prevent double counting.**
  `inventory_ledger` is partitioned by month, so its key is `(id, occurred_at)`
  and not `id` alone. A replay reusing the id while letting `occurred_at` default
  to `now()` inserted a second row while appearing protected. The repository now
  refuses a deterministic id without a deterministic timestamp, and the sync path
  derives the timestamp from the UUIDv7's own embedded clock so the two cannot
  disagree.
- **The seed was not re-runnable.** It deleted the organization, which
  `ON DELETE RESTRICT` correctly forbids once stores exist. It now clears its own
  tables in dependency order. The earlier "idempotent" check had passed against a
  state that did not exercise the constraint.

### Security

- The API refuses to start if it detects a database role that owns tables, is a
  superuser, or has `BYPASSRLS`.
- Refresh token rotation with family revocation on reuse.
- Argon2id for passwords; cheaper parameters plus lockout for register PINs.
- Constant time response for unknown accounts at login.
- Upgraded NestJS to 12 and drizzle-orm to 0.45.2, clearing a high severity SQL
  injection advisory (GHSA-gpj5-g38j-94v9) and two fastify advisories.

### Documentation

`SECURITY.md`, `DATABASE.md`, `API.md`, `MONEY.md`, `COMPLIANCE.md`,
`INTEGRATIONS.md`, `DEPLOYMENT.md`, `TESTING.md`.

---

## Phase 0 — Repository foundation

The architecture and migrations existed; the repository did not. Nine files sat
flat in the project root while the README and the invariant test referenced a
layout that had never been created.

### Added

- npm workspaces monorepo (npm rather than pnpm and Turborepo: it ships with
  Node and needs no install step on a new machine).
- Migration runner with checksum tracking, so editing an applied migration is a
  hard error rather than a silent divergence.
- `bootstrap-roles.sql` — the `snappos_migrator` / `snappos_app` split. **Nothing
  previously created these roles**, which meant RLS had never been exercised
  against a non-owner.
- RLS test suite, 9 tests, connecting as the unprivileged role.
- Dual engine testing: every suite runs on PGlite and on real PostgreSQL 16.
- Seed with a realistic catalog — six products, twelve variants, one deliberately
  out of stock. Opening stock posts through the ledger.
- CI: PGlite as the fast gate, PostgreSQL as the authoritative one.

### Fixed

- The README's "26 passing tests" **could not be reproduced by anyone**: no
  `package.json`, no PGlite dependency, no `migrate.test.mjs`. All 26 now pass on
  both engines.
- The claimed "78 check constraints" was partition inclusive and therefore date
  dependent — `ensure_monthly_partitions()` creates partitions relative to
  `now()`, and it had already drifted to 76. Tests now assert only counts that
  are stable facts about the migrations.
- PostgreSQL test files run serially. Each bootstraps roles and grants, which
  write cluster wide catalogs, and running them in parallel produced
  `tuple concurrently updated` at random points.

---

## Prior work

Architecture (`docs/ARCHITECTURE.md`, sections A–O) and the Phase 1 schema:
63 tables, 93 foreign keys, 20 enums, RLS policies, append only triggers,
monthly partitioning, UUIDv7 generation.
