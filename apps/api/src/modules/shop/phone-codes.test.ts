import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneCodes } from './phone-codes.js';

const SECRET = 'a-test-secret-that-is-comfortably-longer-than-32';

test('the code that was issued matches, and nothing else does', () => {
  const codes = new PhoneCodes(SECRET);
  const { code, hash } = codes.issue('+12545550123');
  assert.match(code, /^\d{6}$/);
  assert.ok(codes.matches('+12545550123', code, hash));
  assert.ok(codes.matches('+12545550123', ` ${code} `, hash));
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal(codes.matches('+12545550123', wrong, hash), false);
});

test("a code sent to one phone doesn't prove a different phone", () => {
  const codes = new PhoneCodes(SECRET);
  const { code, hash } = codes.issue('+12545550123');
  assert.equal(codes.matches('+12545550199', code, hash), false);
});

test('what is stored is keyed: without the server secret, trying all million codes finds nothing', () => {
  const codes = new PhoneCodes(SECRET);
  const { code, hash } = codes.issue('+12545550123');
  assert.equal(new PhoneCodes('another-secret-that-is-also-longer-than-32-chars').matches('+12545550123', code, hash), false);
});
