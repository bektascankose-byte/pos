import { createHmac } from 'node:crypto';

export interface DoorDashCredentials {
  developerId: string;
  keyId: string;
  /** As DoorDash issues it: base64url. The HMAC key is the decoded bytes, not the string. */
  signingSecret: string;
}

/**
 * The token DoorDash Drive expects on every request.
 *
 * HS256 over DoorDash's own header (`dd-ver: DD-JWT-V1`) and claims (`aud`
 * "doordash", `iss` the developer id, `kid` the key id). DoorDash allows at
 * most thirty minutes of life; five is plenty for one request and limits what
 * a leaked token is worth.
 */
export function doordashJwt(credentials: DoorDashCredentials, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' };
  const payload = {
    aud: 'doordash',
    iss: credentials.developerId,
    kid: credentials.keyId,
    iat: issuedAt,
    exp: issuedAt + 300,
  };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac('sha256', Buffer.from(credentials.signingSecret, 'base64url'))
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}
