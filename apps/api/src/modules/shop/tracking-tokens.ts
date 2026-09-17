import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Order tracking links.
 *
 * A link has to be unguessable, because it shows the customer's first name,
 * what they ordered and when it will be ready. It does not have to be stored:
 * the token is the order id and a signature over it, so anything holding the
 * server's secret can re-create it -- including the email sent an hour later
 * by the outbox, whose event carries only the order id. Nothing secret sits in
 * a table, a queue or a log.
 *
 * The key is derived from `JWT_SECRET` under its own label rather than being
 * that secret, so a tracking link and an access token can never be mistaken
 * for one another even though one secret stands behind both. Rotating that
 * secret retires every outstanding link, which is the right outcome if it ever
 * leaked.
 */
export class TrackingTokens {
  private readonly key: Buffer;

  constructor(secret: string | undefined = process.env.JWT_SECRET) {
    const material = secret && secret.length >= 32 ? secret : randomBytes(32).toString('hex');
    this.key = Buffer.from(hkdfSync('sha256', material, 'snappos', 'order-tracking-v1', 32));
  }

  sign(orgId: string, orderId: string): string {
    const id = Buffer.from(orderId.replace(/-/g, ''), 'hex').toString('base64url');
    return `${id}.${this.mac(orgId, orderId)}`;
  }

  /** The order id a token names, or null for anything that is not a genuine token for this org. */
  verify(orgId: string, token: string): string | null {
    const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;

    const hex = Buffer.from(match[1]!, 'base64url').toString('hex');
    if (hex.length !== 32) return null;
    const orderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

    // Compare the whole link with the one this order would get, not the decoded
    // bytes: the last character of each half carries bits a decoder ignores, so
    // byte comparison would let one link be spelled 64 different ways.
    const expected = Buffer.from(this.sign(orgId, orderId));
    const presented = Buffer.from(token);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;

    return orderId;
  }

  private mac(orgId: string, orderId: string): string {
    return createHmac('sha256', this.key).update(`${orgId}:${orderId}`).digest('base64url');
  }
}
