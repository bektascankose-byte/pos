// The pump's orchestration, with a fake service standing in for the database.
// The SQL contract is proved separately against real Postgres; what is tested
// here is what the pump decides to do with what it gets back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutboxPump } from './outbox.pump.js';
import type { ClaimedEvent, OutboxService } from './outbox.service.js';

interface Recorded {
  delivered: string[];
  failed: { id: string; attempts: number; error: string; maxAttempts: number }[];
}

function fakeOutbox(events: ClaimedEvent[]): { service: OutboxService; recorded: Recorded } {
  const recorded: Recorded = { delivered: [], failed: [] };
  const service = {
    async claim() {
      return events.splice(0, events.length);
    },
    async markDelivered(id: string) {
      recorded.delivered.push(id);
    },
    async markFailed(id: string, attempts: number, error: string, maxAttempts: number) {
      recorded.failed.push({ id, attempts, error, maxAttempts });
    },
  } as unknown as OutboxService;
  return { service, recorded };
}

function event(over: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    eventType: 'order.placed',
    aggregateType: 'order',
    aggregateId: 'ord-1',
    payload: { total_minor: '1299' },
    correlationId: 'corr-1',
    attempts: 1,
    ...over,
  };
}

/** The pump schedules its next tick on construction-time config; stop it so tests don't leave timers running. */
function pumpFor(events: ClaimedEvent[]) {
  const { service, recorded } = fakeOutbox(events);
  const pump = new OutboxPump(service);
  return { pump, recorded };
}

test('a handled event is marked delivered', async () => {
  const { pump, recorded } = pumpFor([event()]);
  const seen: unknown[] = [];
  pump.register('order.placed', async (payload) => {
    seen.push(payload);
  });

  assert.equal(await pump.tick(), 1);
  assert.deepEqual(recorded.delivered, ['evt-1']);
  assert.deepEqual(recorded.failed, []);
  assert.deepEqual(seen, [{ total_minor: '1299' }]);
});

test('the handler is given the event\'s own org, not the caller\'s', async () => {
  const { pump } = pumpFor([event({ orgId: 'org-9', correlationId: 'corr-9', attempts: 3 })]);
  let ctx: { orgId: string; correlationId: string | null; attempts: number } | null = null;
  pump.register('order.placed', async (_p, c) => {
    ctx = c;
  });

  await pump.tick();
  assert.deepEqual(ctx, { orgId: 'org-9', correlationId: 'corr-9', attempts: 3 });
});

test('an event with no handler is delivered, not retried forever', async () => {
  // During a phased build, an event legitimately has no listener yet. Retrying
  // one would fill the dead letters with noise about a phase not written.
  const { pump, recorded } = pumpFor([event({ eventType: 'nobody.listens' })]);

  assert.equal(await pump.tick(), 0, 'nothing was handled');
  assert.deepEqual(recorded.delivered, ['evt-1'], 'but it is not left pending');
  assert.deepEqual(recorded.failed, []);
});

test('a throwing handler records the failure and hands the retry decision on', async () => {
  const { pump, recorded } = pumpFor([event({ attempts: 2 })]);
  pump.register('order.placed', async () => {
    throw new Error('provider timed out');
  });

  assert.equal(await pump.tick(), 0);
  assert.deepEqual(recorded.delivered, []);
  assert.equal(recorded.failed.length, 1);
  assert.equal(recorded.failed[0]!.attempts, 2);
  assert.match(recorded.failed[0]!.error, /provider timed out/);
  assert.ok(recorded.failed[0]!.maxAttempts > 0, 'the cap must be passed through, not assumed');
});

test('one failing event does not stop the ones behind it', async () => {
  const { pump, recorded } = pumpFor([
    event({ id: 'a', eventType: 'boom' }),
    event({ id: 'b' }),
    event({ id: 'c' }),
  ]);
  pump.register('boom', async () => {
    throw new Error('nope');
  });
  pump.register('order.placed', async () => {});

  assert.equal(await pump.tick(), 2);
  assert.deepEqual(recorded.delivered, ['b', 'c']);
  assert.deepEqual(recorded.failed.map((f) => f.id), ['a']);
});

test('registering the same event type twice is refused', async () => {
  // Two modules quietly fighting over `order.placed` shows up in production as
  // a notification sent twice, and nowhere earlier.
  const { pump } = pumpFor([]);
  pump.register('order.placed', async () => {});
  assert.throws(() => pump.register('order.placed', async () => {}), /already registered/);
});

test('a claim failure is swallowed so the pump survives to tick again', async () => {
  const service = {
    async claim() {
      throw new Error('database unreachable');
    },
  } as unknown as OutboxService;
  const pump = new OutboxPump(service);

  // Infrastructure being down must not kill the only pump in the process.
  await assert.doesNotReject(() => pump.tick());
  assert.equal(await pump.tick(), 0);
});
