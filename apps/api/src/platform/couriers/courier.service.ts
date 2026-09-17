import { Injectable } from '@nestjs/common';
import type { CourierMode } from '@snappos/contracts';
import { ApiException } from '../errors/api-exception.js';
import type { Courier } from './courier.js';
import { DoorDashDriveCourier } from './doordash-drive.courier.js';
import { SimulatedCourier } from './simulated.courier.js';

/**
 * Which courier this server uses, decided by its configuration.
 *
 * DoorDash when all three credentials are set. Otherwise a simulation -- but
 * only outside production: a live shop with no courier must not quietly take
 * delivery orders that nobody will ever collect.
 */
@Injectable()
export class CourierService {
  private cached: Courier | null | undefined;

  mode(): CourierMode {
    if (this.credentials()) return 'live';
    return process.env.NODE_ENV === 'production' ? 'unavailable' : 'simulated';
  }

  /** The courier, or a clear refusal when this server has none. */
  courier(): Courier {
    if (this.cached === undefined) {
      const credentials = this.credentials();
      this.cached = credentials
        ? new DoorDashDriveCourier(credentials)
        : process.env.NODE_ENV === 'production'
          ? null
          : new SimulatedCourier();
    }
    if (!this.cached) {
      throw new ApiException(
        'provider_unavailable',
        'delivery is not set up on this server -- set DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID and DOORDASH_SIGNING_SECRET',
        { retryable: false },
      );
    }
    return this.cached;
  }

  private credentials() {
    const developerId = process.env.DOORDASH_DEVELOPER_ID;
    const keyId = process.env.DOORDASH_KEY_ID;
    const signingSecret = process.env.DOORDASH_SIGNING_SECRET;
    return developerId && keyId && signingSecret ? { developerId, keyId, signingSecret } : null;
  }
}
