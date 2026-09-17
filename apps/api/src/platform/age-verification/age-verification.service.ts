import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../errors/api-exception.js';

export interface AgeCheckRequest {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. Passed to the check and not kept by this system. */
  dateOfBirth: string;
  address: { line1: string; city: string; region: string; postalCode: string };
  minimumAge: number;
  /** The shop's timezone, so a birthday is judged by the shop's calendar. */
  timezone: string;
}

export interface AgeCheckResult {
  provider: string;
  /** The provider's reference for this check. Stored; nothing else from it is. */
  reference: string;
  passed: boolean;
  simulated: boolean;
  /** Safe to show the customer when it did not pass. */
  message: string | null;
}

/**
 * Checking a buyer's age before a delivery order is taken.
 *
 * A delivery sale of tobacco is not handed over at a counter, so rules for
 * delivery sales require the seller to verify the buyer's age and identity
 * against public records before accepting the order, as well as checking ID
 * at the door. The records check needs a provider -- the likes of Veratad,
 * AgeChecker.Net or IDology -- and the shop has not chosen one.
 *
 * Until it does, this is a test check that only works out an age from the date
 * the customer typed. It verifies nothing and says so: every result carries
 * `simulated`, and the storefront labels the step as a test. What to verify and
 * how is a question for the shop's attorney; this makes it a step that cannot
 * be skipped once they have answered it.
 */
@Injectable()
export class AgeVerificationService {
  mode(): 'live' | 'simulated' | 'unavailable' {
    return process.env.NODE_ENV === 'production' ? 'unavailable' : 'simulated';
  }

  async check(request: AgeCheckRequest): Promise<AgeCheckResult> {
    if (this.mode() === 'unavailable') {
      throw new ApiException(
        'provider_unavailable',
        'age verification for delivery is not set up on this server -- an age verification provider has to be chosen first',
        { retryable: false },
      );
    }

    const age = ageOn(request.dateOfBirth, todayIn(request.timezone));
    const passed = age !== null && age >= request.minimumAge && age < 120;
    return {
      provider: 'test',
      reference: `test_age_${randomUUID()}`,
      passed,
      simulated: true,
      message: passed
        ? null
        : age === null
          ? 'Enter a real date of birth.'
          : `You must be ${request.minimumAge} or older to order these items.`,
    };
  }
}

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD day, or null for a date that does not exist. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  const now = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!birth || !now) return null;
  const [by, bm, bd] = [Number(birth[1]), Number(birth[2]), Number(birth[3])];
  const probe = new Date(Date.UTC(by, bm - 1, bd));
  if (probe.getUTCFullYear() !== by || probe.getUTCMonth() !== bm - 1 || probe.getUTCDate() !== bd) return null;
  const [ny, nm, nd] = [Number(now[1]), Number(now[2]), Number(now[3])];
  const age = ny - by - (nm < bm || (nm === bm && nd < bd) ? 1 : 0);
  return age < 0 ? null : age;
}

function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}
