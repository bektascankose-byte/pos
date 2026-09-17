import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../errors/api-exception.js';

export interface PaymentAuthorization {
  provider: string;
  reference: string;
  approved: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Safe to show the customer. */
  declineReason: string | null;
}

/**
 * A card processor: hold money at checkout, take it at handover, release it if
 * the order never gets there.
 */
export interface PaymentProcessor {
  readonly name: string;
  readonly simulated: boolean;
  authorize(input: { amountMinor: bigint; token: string; description: string }): Promise<PaymentAuthorization>;
  capture(reference: string, amountMinor: bigint): Promise<void>;
  release(reference: string): Promise<void>;
}

/** The tokens the test processor understands. The storefront sends the first on a server with no processor. */
export const TEST_PAYMENT_APPROVE = 'test-approve';
export const TEST_PAYMENT_DECLINE = 'test-decline';

/**
 * Payments that take no money, for a server with no card processor.
 *
 * Most processors refuse tobacco and vape merchants outright, so choosing one
 * is its own decision; until then the whole online-payment flow runs against
 * this. No card number is ever asked for. The storefront says "test payment"
 * wherever it would ask for a card, and every order paid this way is marked
 * as such.
 */
class TestPaymentProcessor implements PaymentProcessor {
  readonly name = 'test';
  readonly simulated = true;

  async authorize(input: { amountMinor: bigint; token: string }): Promise<PaymentAuthorization> {
    const approved = input.token === TEST_PAYMENT_APPROVE;
    if (!approved && input.token !== TEST_PAYMENT_DECLINE) {
      throw new ApiException('validation_failed', 'this server only takes test payments', { retryable: false });
    }
    return {
      provider: this.name,
      reference: `test_pay_${randomUUID()}`,
      approved,
      cardBrand: approved ? 'Test' : null,
      cardLast4: approved ? '4242' : null,
      declineReason: approved ? null : 'The card was declined. Try another card.',
    };
  }

  async capture(): Promise<void> {}
  async release(): Promise<void> {}
}

@Injectable()
export class PaymentsService {
  private readonly test = new TestPaymentProcessor();

  /** Whether orders can be paid online here, and whether that is for real. */
  mode(): 'live' | 'simulated' | 'unavailable' {
    return process.env.NODE_ENV === 'production' ? 'unavailable' : 'simulated';
  }

  processor(): PaymentProcessor {
    if (this.mode() === 'unavailable') {
      throw new ApiException(
        'provider_unavailable',
        'online payment is not set up on this server -- a card processor that accepts this kind of shop has to be chosen first',
        { retryable: false },
      );
    }
    return this.test;
  }

  /** The processor that took a payment, found again by the name recorded with it. */
  processorNamed(name: string): PaymentProcessor {
    if (name === this.test.name) return this.test;
    throw new ApiException('provider_unavailable', `no payment processor named "${name}" is configured`, {
      retryable: false,
    });
  }
}
