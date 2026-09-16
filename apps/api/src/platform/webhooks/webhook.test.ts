// The two pure pieces of webhook handling, tested directly. Both exist to stop
// an attack rather than to make a feature work, which is exactly the kind of
// code that gets quietly broken by a refactor and never noticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHmac, withinReplayWindow } from './webhook.service.js';
import { backoffSeconds } from '../outbox/outbox.service.js';

const SECRET = 'whsec_test_not_a_real_secret';
const BODY = Buffer.from('{"event_id":"evt_1","status":"delivered"}');

const hex = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');
const b64 = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64');

test('a correct hex signature verifies', () => {
  assert.equal(verifyHmac(BODY, hex(BODY), SECRET), true);
});

test('a correct base64 signature verifies -- providers disagree about encoding', () => {
  assert.equal(verifyHmac(BODY, b64(BODY), SECRET), true);
});

test('a "sha256=" prefix is tolerated', () => {
  assert.equal(verifyHmac(BODY, `sha256=${hex(BODY)}`, SECRET), true);
});

test('a body altered by one byte does not verify', () => {
  const signature = hex(BODY);
  const tampered = Buffer.from('{"event_id":"evt_1","status":"cancelled"}');
  assert.equal(verifyHmac(tampered, signature, SECRET), false);
});

test('a signature made with the wrong secret does not verify', () => {
  assert.equal(verifyHmac(BODY, hex(BODY, 'someone_elses_secret'), SECRET), false);
});

test('missing signature or secret is a miss, never a pass', () => {
  assert.equal(verifyHmac(BODY, '', SECRET), false);
  assert.equal(verifyHmac(BODY, hex(BODY), ''), false);
});

test('a malformed signature is a miss rather than a throw', () => {
  // timingSafeEqual throws on a length mismatch; a caller handling a hostile
  // request must get `false`, not an exception that becomes a 500.
  assert.equal(verifyHmac(BODY, 'zzzz', SECRET), false);
  assert.equal(verifyHmac(BODY, 'a'.repeat(63), SECRET), false);
  assert.doesNotThrow(() => verifyHmac(BODY, '!!!!', SECRET));
});

test('replay window accepts now and rejects an old capture', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(withinReplayWindow(now), true);
  assert.equal(withinReplayWindow(now - 60), true);
  // A valid signature stays valid forever, so this is the only thing stopping
  // a captured "delivered" from being replayed onto a later order.
  assert.equal(withinReplayWindow(now - 3600), false);
});

test('replay window rejects a timestamp from the future', () => {
  assert.equal(withinReplayWindow(Math.floor(Date.now() / 1000) + 3600), false);
});

test('replay window accepts milliseconds as well as seconds', () => {
  assert.equal(withinReplayWindow(Date.now()), true);
});

test('replay window rejects nonsense rather than treating it as now', () => {
  assert.equal(withinReplayWindow('not-a-timestamp'), false);
  assert.equal(withinReplayWindow(Number.NaN), false);
});

test('backoff grows and is capped', () => {
  // Jittered, so each is a range rather than a number.
  const first = backoffSeconds(1);
  assert.ok(first >= 3 && first <= 8, `first retry ${first}s should be seconds, not minutes`);

  const later = backoffSeconds(6);
  assert.ok(later > first, 'backoff must grow with attempts');

  // Without a ceiling, attempt 20 would schedule the retry past the heat death
  // of the shop.
  assert.ok(backoffSeconds(20) <= 3600 * 1.25, 'backoff must be capped');
});

test('backoff is jittered, so a recovering provider is not stampeded', () => {
  const samples = new Set(Array.from({ length: 24 }, () => backoffSeconds(5)));
  assert.ok(samples.size > 1, 'every retry firing at the same instant is the bug this prevents');
});
