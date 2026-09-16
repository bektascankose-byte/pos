// The order state machine. Every test here is about a transition that must NOT
// happen — the ones that must are easy and rarely the bug. A courier webhook
// arriving out of order, a staff member double-tapping Ready, a retried
// request: each tries to move an order somewhere it cannot go, and each is a
// weekly occurrence rather than a hypothetical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition,
  canTransition,
  InvalidOrderTransition,
  isTerminal,
  movesStock,
  holdsClaim,
  nextStatuses,
  readableStatus,
  type OrderStatus,
} from '@snappos/contracts';

const ALL: OrderStatus[] = [
  'placed', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled',
  'pending_payment', 'payment_failed', 'courier_requested', 'in_transit',
  'delivery_failed', 'returned_to_store',
];

test('the happy pickup path is walkable end to end', () => {
  assert.ok(canTransition('placed', 'accepted'));
  assert.ok(canTransition('accepted', 'preparing'));
  assert.ok(canTransition('preparing', 'ready'));
  assert.ok(canTransition('ready', 'completed'));
});

test('preparing is optional — a shop with the item on the shelf skips it', () => {
  // Forcing a click nobody needs is how staff stop using the screen and start
  // phoning each other.
  assert.ok(canTransition('accepted', 'ready'));
});

test('an order cannot skip straight from placed to ready or completed', () => {
  assert.equal(canTransition('placed', 'ready'), false);
  assert.equal(canTransition('placed', 'completed'), false);
});

test('a completed order is final in every direction', () => {
  assert.ok(isTerminal('completed'));
  for (const to of ALL) {
    assert.equal(canTransition('completed', to), false, `completed → ${to} must be refused`);
  }
});

test('rejected and cancelled are final too', () => {
  for (const from of ['rejected', 'cancelled'] as const) {
    assert.ok(isTerminal(from));
    for (const to of ALL) {
      assert.equal(canTransition(from, to), false, `${from} → ${to} must be refused`);
    }
  }
});

test('completing twice is refused — this is what makes a double tap safe', () => {
  assert.throws(() => assertTransition('completed', 'completed'), InvalidOrderTransition);
});

test('an order cannot go backwards', () => {
  assert.equal(canTransition('ready', 'accepted'), false);
  assert.equal(canTransition('preparing', 'placed'), false);
  assert.equal(canTransition('accepted', 'placed'), false);
});

test('stock moves at completion and nowhere else', () => {
  // The single fact the inventory ledger hangs off. If this ever becomes true
  // for another status, a sale gets written without a handover.
  for (const status of ALL) {
    assert.equal(movesStock(status), status === 'completed', `movesStock(${status})`);
  }
});

test('an order holds its claim on stock until it reaches a terminal state', () => {
  assert.ok(holdsClaim('placed'));
  assert.ok(holdsClaim('ready'));
  assert.equal(holdsClaim('completed'), false);
  assert.equal(holdsClaim('cancelled'), false);
  assert.equal(holdsClaim('rejected'), false);
});

test('delivery statuses exist but are not reachable from the pickup path', () => {
  // Declared so the vocabulary is complete; unreachable until the phase that
  // earns them. The register must not be able to put an order into a courier
  // state that nothing is driving.
  assert.equal(canTransition('accepted', 'courier_requested'), false);
  assert.equal(canTransition('preparing', 'in_transit'), false);
  // Ready is the one legitimate door into the courier flow.
  assert.ok(canTransition('ready', 'courier_requested'));
});

test('a failed delivery can come back and go out again, but never silently complete', () => {
  assert.ok(canTransition('delivery_failed', 'returned_to_store'));
  assert.ok(canTransition('returned_to_store', 'ready'));
  assert.equal(canTransition('delivery_failed', 'completed'), false);
});

test('payment states are declared and unreachable from anything live', () => {
  for (const from of ['placed', 'accepted', 'preparing', 'ready'] as const) {
    assert.equal(canTransition(from, 'pending_payment'), false);
    assert.equal(canTransition(from, 'payment_failed'), false);
  }
});

test('every status in the enum has an entry, so none is reachable-from-nowhere by accident', () => {
  for (const status of ALL) {
    // nextStatuses returns [] for terminal states and a list otherwise; an
    // undefined entry would mean a status the table forgot, which `canTransition`
    // would then refuse in every direction without anybody noticing.
    assert.ok(Array.isArray(nextStatuses(status)), `${status} missing from the transition table`);
  }
});

test('every reachable target is itself a known status', () => {
  // Catches a typo in the table that would otherwise read as "unreachable".
  for (const from of ALL) {
    for (const to of nextStatuses(from)) {
      assert.ok(ALL.includes(to), `${from} → ${to} is not a real status`);
    }
  }
});

test('the error tells a person what they can do instead', () => {
  const error = new InvalidOrderTransition('placed', 'completed');
  assert.match(error.message, /new/);
  assert.match(error.message, /accepted/);

  const terminal = new InvalidOrderTransition('completed', 'ready');
  assert.match(terminal.message, /already completed/);
});

test('every status reads as something a person would say', () => {
  for (const status of ALL) {
    const readable = readableStatus(status);
    assert.ok(readable.length > 0, `${status} has no readable form`);
    assert.equal(readable.includes('_'), false, `${readable} still looks like an enum`);
  }
});
