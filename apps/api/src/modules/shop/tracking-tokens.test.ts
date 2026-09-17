import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingTokens } from './tracking-tokens.js';

const SECRET = 'a-test-secret-that-is-comfortably-longer-than-32';
const ORG = '01a0922c-46f1-71ce-b15c-18e94289f115';
const OTHER_ORG = '01a0922c-46f1-71ce-b15c-18e94289f116';
const ORDER = '01a0a9fa-fd98-71c6-8e4f-c5d613ccd6b6';

test('a signed link names its order', () => {
  const tokens = new TrackingTokens(SECRET);
  assert.equal(tokens.verify(ORG, tokens.sign(ORG, ORDER)), ORDER);
});

test('the same order always gets the same link, so an email sent later matches the page', () => {
  assert.equal(new TrackingTokens(SECRET).sign(ORG, ORDER), new TrackingTokens(SECRET).sign(ORG, ORDER));
});

test('changing the order id in a link does not reach a different order', () => {
  const tokens = new TrackingTokens(SECRET);
  const [id, mac] = tokens.sign(ORG, ORDER).split('.');
  // Flip one character of the id half and keep the signature.
  const forged = `${id!.slice(0, -1)}${id!.endsWith('A') ? 'B' : 'A'}.${mac}`;
  assert.equal(tokens.verify(ORG, forged), null);
});

test('a link has exactly one spelling', () => {
  const tokens = new TrackingTokens(SECRET);
  const [id, mac] = tokens.sign(ORG, ORDER).split('.') as [string, string];
  // The last character of each half carries bits a decoder ignores -- four in the
  // id, two in the signature -- so flipping the lowest one decodes to the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const respell = (half: string) => half.slice(0, -1) + alphabet.charAt(alphabet.indexOf(half.slice(-1)) ^ 1);
  assert.deepEqual(Buffer.from(respell(id), 'base64url'), Buffer.from(id, 'base64url'));
  assert.deepEqual(Buffer.from(respell(mac), 'base64url'), Buffer.from(mac, 'base64url'));
  assert.equal(tokens.verify(ORG, `${respell(id)}.${mac}`), null);
  assert.equal(tokens.verify(ORG, `${id}.${respell(mac)}`), null);
});

test("one shop's link does not open another shop's order", () => {
  const tokens = new TrackingTokens(SECRET);
  assert.equal(tokens.verify(OTHER_ORG, tokens.sign(ORG, ORDER)), null);
});

test('a link signed with a different secret is refused', () => {
  const token = new TrackingTokens('another-secret-that-is-also-longer-than-32-chars').sign(ORG, ORDER);
  assert.equal(new TrackingTokens(SECRET).verify(ORG, token), null);
});

test('anything that is not shaped like a link is refused without throwing', () => {
  const tokens = new TrackingTokens(SECRET);
  for (const junk of ['', 'abc', 'HH01-260916-001', `${'A'.repeat(22)}.${'B'.repeat(43)}`, '../../etc/passwd']) {
    assert.equal(tokens.verify(ORG, junk), null, junk);
  }
});

test('the link is not the order number, which is sequential and guessable', () => {
  const token = new TrackingTokens(SECRET).sign(ORG, ORDER);
  assert.ok(token.length >= 60, token);
  assert.equal(token.includes('HH01'), false);
});
