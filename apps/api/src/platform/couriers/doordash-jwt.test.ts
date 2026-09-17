import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { doordashJwt } from './doordash-jwt.js';

const credentials = {
  developerId: 'dev-123',
  keyId: 'key-456',
  // Base64url of the bytes "a-signing-secret-for-tests-only", as DoorDash would issue one.
  signingSecret: Buffer.from('a-signing-secret-for-tests-only').toString('base64url'),
};

test('the token carries the header and claims DoorDash checks', () => {
  const [header, payload] = doordashJwt(credentials, new Date('2026-09-17T12:00:00Z')).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), {
    alg: 'HS256',
    typ: 'JWT',
    'dd-ver': 'DD-JWT-V1',
  });
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  assert.equal(claims.aud, 'doordash');
  assert.equal(claims.iss, 'dev-123');
  assert.equal(claims.kid, 'key-456');
  assert.equal(claims.exp - claims.iat, 300);
});

test('it is signed with the decoded secret, not the text of it', () => {
  const token = doordashJwt(credentials, new Date('2026-09-17T12:00:00Z'));
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', Buffer.from('a-signing-secret-for-tests-only'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  assert.equal(signature, expected);
});
