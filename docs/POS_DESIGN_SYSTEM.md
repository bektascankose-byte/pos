# SnapPOS Register Design System

The register is a task-focused workspace for high-volume retail. It prioritizes scan speed, clear totals, visible compliance state, and recovery from hardware or network failure. It is not a miniature admin dashboard.

## Principles

1. The scan field is always immediately available while selling.
2. Every primary cashier target is at least 56 dp; payment targets are at least 72 dp.
3. Offline operation is presented as safe and expected. Amber means pending uploads; red is reserved for an error requiring action.
4. Money uses tabular numerals and is stored and calculated in integer minor units.
5. Destructive actions require confirmation. Sensitive actions remain permission-checked in the view model and domain layer, not merely hidden in the interface.
6. A visible action must work end to end. Future payment, customer, hold, and hardware actions are not shown as inert controls.

## Layout

- Header: register identity, synchronization state, cashier, receipts, returns, shift controls, and lock.
- Catalog rail: high-frequency category navigation with persistent selection.
- Product workspace: scanner/search input followed by large product tiles.
- Current sale: customer context, selected-line actions, cart lines, compliance prompt, totals, and charge action.

On compact landscape devices, the category and cart columns use fixed operational widths while the catalog receives the remaining space. Labels must truncate rather than wrap inside narrow rails.

## Tokens

- Spacing follows an 8 dp grid, with a 4 dp micro-step.
- Corners: 12–16 dp for controls and cards, 24 dp for focused dialogs and secure entry panels.
- Dark background: `#080B12`; surface: `#101621`; elevated surface: `#182131`.
- Action accent: `#6D7CFF`; success: `#2DD4A8`; warning: `#FFB84D`; error: `#FF647C`.
- The accent color means “interactive or selected.” It is not decorative.

## Core Components

- `RegisterHeader`: persistent operational context and shift actions.
- `SyncPill`: online, syncing, pending, and error states.
- `ScanField`: keyboard, HID scanner, and IME-safe product entry.
- `ProductTileCard`: product, variant, price, and unmistakable stock state.
- `CartRow`: selectable line with quantity controls, line total, and age state.
- `RegisterAction`: secondary cart action with permission enforced below the UI.
- `DiscountDialog`: bounded amount and required reason code.
- `AgeGate`: blocking compliance action shown before payment.
- `UnlockScreen`: offline-capable employee selection and private PIN entry.

## Accessibility and Interaction

- Text and icons maintain WCAG AA contrast in both palettes.
- Color is never the sole carrier of inventory, synchronization, or compliance meaning.
- Scanner input does not depend on animation or network access.
- Content descriptions identify icon-only controls.
- Selected rows and disabled controls have visual states beyond color alone.

## Planned Functional Surfaces

The next register milestones are durable hold/resume, customer attachment, manager-authorized price override and tax exemption, configurable quick keys, split tender, and hardware status. Each is added only with persistence, permission checks, audit data, and offline behavior implemented.
