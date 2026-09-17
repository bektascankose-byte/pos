import { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Six-digit codes texted to prove a phone number.
 *
 * A code has only a million possible values, so how it is stored matters more
 * than for a long link token: a plain hash of six digits is reversed by trying
 * them all. It is kept as an HMAC under a key derived from `JWT_SECRET` (under
 * its own label, like tracking links), so the table alone is no help. Guessing
 * online is bounded separately -- a handful of attempts per code, codes that
 * expire in minutes, and a cap on how many are sent.
 */
export class PhoneCodes {
  private readonly key: Buffer;

  constructor(secret: string | undefined = process.env.JWT_SECRET) {
    const material = secret && secret.length >= 32 ? secret : randomBytes(32).toString('hex');
    this.key = Buffer.from(hkdfSync('sha256', material, 'snappos', 'phone-code-v1', 32));
  }

  /** A fresh code, and what to store for it. */
  issue(phone: string): { code: string; hash: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { code, hash: this.hash(phone, code) };
  }

  /** Whether a typed code is the one issued for this phone. Constant time. */
  matches(phone: string, typed: string, stored: string): boolean {
    const a = Buffer.from(this.hash(phone, typed.trim()), 'hex');
    const b = Buffer.from(stored, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private hash(phone: string, code: string): string {
    // Bound to the phone, so a code for one number is no good for another.
    return createHmac('sha256', this.key).update(`${phone}:${code}`).digest('hex');
  }
}
