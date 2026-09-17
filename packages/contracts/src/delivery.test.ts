import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, ORDER_STATUSES } from './order-state.js';
import {
  COURIER_EVENTS,
  courierSteps,
  deliveryFeeFor,
  deliveryRefusal,
  doordashCourierEvent,
  NICOTINE_WARNING,
} from './delivery.js';

const terms = { postal_codes: ['76548', '76542'], fee_minor: 499n, free_over_minor: 5000n, minimum_subtotal_minor: 1500n };

test('the fee is charged below the free-delivery line and not at or above it', () => {
  assert.equal(deliveryFeeFor(terms, 4999n), 499n);
  assert.equal(deliveryFeeFor(terms, 5000n), 0n);
  assert.equal(deliveryFeeFor({ ...terms, free_over_minor: null }, 100_000n), 499n);
});

test('delivery is refused outside the area and under the minimum, with a reason a customer can act on', () => {
  assert.equal(deliveryRefusal(terms, '76548', 2000n), null);
  assert.match(deliveryRefusal(terms, '78701', 2000n) ?? '', /don't deliver to 78701/);
  assert.match(deliveryRefusal(terms, '76542', 1499n) ?? '', /start at \$15\.00/);
  assert.match(deliveryRefusal(terms, null, 2000n) ?? '', /ZIP code/);
});

test('every step a courier report takes is a transition the order state machine allows', () => {
  for (const event of COURIER_EVENTS) {
    for (const start of ORDER_STATUSES) {
      let at = start;
      for (const next of courierSteps(event, start)) {
        assert.ok(canTransition(at, next), `${event} from ${start}: ${at} -> ${next}`);
        at = next;
      }
    }
  }
});

test('a delivered report for an order whose pickup report was lost still completes it', () => {
  assert.deepEqual(courierSteps('delivered', 'courier_requested'), ['in_transit', 'completed']);
  assert.deepEqual(courierSteps('delivered', 'in_transit'), ['completed']);
});

test('a report repeated after it took effect changes nothing', () => {
  assert.deepEqual(courierSteps('picked_up', 'in_transit'), []);
  assert.deepEqual(courierSteps('delivered', 'completed'), []);
  assert.deepEqual(courierSteps('returned', 'returned_to_store'), []);
  assert.deepEqual(courierSteps('driver_assigned', 'courier_requested'), []);
});

test('a delivery that comes back walks through failed to returned', () => {
  assert.deepEqual(courierSteps('returning', 'in_transit'), ['delivery_failed']);
  assert.deepEqual(courierSteps('returned', 'delivery_failed'), ['returned_to_store']);
  assert.deepEqual(courierSteps('returned', 'in_transit'), ['delivery_failed', 'returned_to_store']);
});

test("DoorDash's event names map onto courier events, and the ones nothing acts on map to nothing", () => {
  assert.equal(doordashCourierEvent('DASHER_PICKED_UP'), 'picked_up');
  assert.equal(doordashCourierEvent('DASHER_DROPPED_OFF'), 'delivered');
  assert.equal(doordashCourierEvent('DELIVERY_RETURNED'), 'returned');
  assert.equal(doordashCourierEvent('DELIVERY_BATCHED'), null);
  assert.equal(doordashCourierEvent('dasher_enroute_to_dropoff'), null);
});

test('the nicotine warning is the exact regulatory wording', () => {
  assert.equal(NICOTINE_WARNING, 'WARNING: This product contains nicotine. Nicotine is an addictive chemical.');
});
