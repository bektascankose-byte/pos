import { Logger } from '@nestjs/common';
import { ApiException } from '../errors/api-exception.js';
import { CourierRefusal, type Courier, type CourierDelivery, type CourierDeliveryRequest, type CourierQuote } from './courier.js';
import { doordashJwt, type DoorDashCredentials } from './doordash-jwt.js';

const BASE_URL = 'https://openapi.doordash.com/drive/v2';

interface DoorDashResponse {
  external_delivery_id?: string;
  delivery_status?: string;
  fee?: number;
  tracking_url?: string;
  support_reference?: string;
  pickup_time_estimated?: string;
  dropoff_time_estimated?: string;
  message?: string;
  code?: string;
  field_errors?: { field?: string; error?: string }[];
}

/**
 * DoorDash Drive, over its v2 REST API.
 *
 * Written from DoorDash's published reference and exercised in tests against a
 * stand-in, not yet against DoorDash itself: the shop's API access is still to
 * come. The first run should be in DoorDash's sandbox, with its delivery
 * simulator walking a delivery through every webhook.
 *
 * Age-restricted orders are sent with `order_contains.tobacco` and require an ID
 * check and a signature at the door, and go back to the shop if the driver
 * cannot hand them over -- never left on a doorstep.
 */
export class DoorDashDriveCourier implements Courier {
  readonly name = 'doordash';
  readonly displayName = 'DoorDash';
  readonly simulated = false;
  private readonly logger = new Logger(DoorDashDriveCourier.name);

  constructor(
    private readonly credentials: DoorDashCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async quote(request: CourierDeliveryRequest): Promise<CourierQuote> {
    // A quote needs an id of its own: the delivery's real id is spent when a
    // driver is booked, which happens later, once the order is packed.
    const body = this.body({ ...request, externalDeliveryId: `${request.externalDeliveryId}-quote-${Date.now()}` });
    const response = await this.call('POST', '/quotes', body);
    return {
      feeMinor: typeof response.fee === 'number' ? BigInt(response.fee) : null,
      estimatedDropoffAt: response.dropoff_time_estimated ?? null,
    };
  }

  async createDelivery(request: CourierDeliveryRequest): Promise<CourierDelivery> {
    try {
      return this.toDelivery(await this.call('POST', '/deliveries', this.body(request)));
    } catch (e) {
      // Already created -- a retry after a timeout that actually succeeded.
      // Asking for it is the idempotent answer.
      if (e instanceof DuplicateDelivery) {
        return this.toDelivery(await this.call('GET', `/deliveries/${encodeURIComponent(request.externalDeliveryId)}`));
      }
      throw e;
    }
  }

  async cancelDelivery(externalDeliveryId: string): Promise<void> {
    await this.call('PUT', `/deliveries/${encodeURIComponent(externalDeliveryId)}/cancel`);
  }

  private body(request: CourierDeliveryRequest): Record<string, unknown> {
    const ageRestricted = request.containsTobacco || request.containsHemp;
    return {
      external_delivery_id: request.externalDeliveryId,
      pickup_address: request.pickup.address,
      pickup_business_name: request.pickup.businessName,
      ...(request.pickup.phone ? { pickup_phone_number: request.pickup.phone } : {}),
      ...(request.pickup.instructions ? { pickup_instructions: request.pickup.instructions } : {}),
      pickup_reference_tag: request.pickup.referenceTag,
      dropoff_address: request.dropoff.address,
      dropoff_phone_number: request.dropoff.phone,
      dropoff_contact_given_name: request.dropoff.givenName,
      dropoff_contact_family_name: request.dropoff.familyName,
      ...(request.dropoff.instructions ? { dropoff_instructions: request.dropoff.instructions } : {}),
      order_value: Number(request.orderValueMinor),
      order_contains: { tobacco: request.containsTobacco, hemp: request.containsHemp },
      ...(ageRestricted ? { dropoff_options: { id_verification: 'required', signature: 'required' } } : {}),
      contactless_dropoff: false,
      action_if_undeliverable: 'return_to_pickup',
      tip: 0,
    };
  }

  private toDelivery(response: DoorDashResponse): CourierDelivery {
    return {
      externalDeliveryId: response.external_delivery_id ?? '',
      status: response.delivery_status ?? 'created',
      feeMinor: typeof response.fee === 'number' ? BigInt(response.fee) : null,
      trackingUrl: response.tracking_url ?? null,
      supportReference: response.support_reference ?? null,
      estimatedPickupAt: response.pickup_time_estimated ?? null,
      estimatedDropoffAt: response.dropoff_time_estimated ?? null,
    };
  }

  private async call(method: string, path: string, body?: Record<string, unknown>): Promise<DoorDashResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${doordashJwt(this.credentials)}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ApiException('provider_unavailable', `could not reach DoorDash: ${e instanceof Error ? e.message : 'network error'}`, {
        retryable: true,
      });
    }

    const payload = (await response.json().catch(() => ({}))) as DoorDashResponse;
    if (response.ok) return payload;

    // The body can quote the address or phone it rejected, so only the code
    // and the field names are logged -- never the payload.
    const fields = payload.field_errors?.map((f) => f.field).filter(Boolean).join(', ');
    this.logger.warn({ status: response.status, code: payload.code, fields }, 'DoorDash refused a request');

    if (response.status === 409) throw new DuplicateDelivery();
    if (response.status === 422) {
      throw new CourierRefusal(
        "DoorDash can't deliver this order to that address. Check the address, or choose pickup.",
        payload.message ?? 'delivery not allowed',
      );
    }
    if (response.status === 400) {
      throw new CourierRefusal(
        'DoorDash could not use the delivery details. Check the address and phone number.',
        payload.message ?? `invalid request${fields ? ` (${fields})` : ''}`,
      );
    }
    throw new ApiException(
      'provider_unavailable',
      response.status === 401 || response.status === 403
        ? 'DoorDash rejected the credentials -- check DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID and DOORDASH_SIGNING_SECRET'
        : `DoorDash returned ${response.status}`,
      { retryable: response.status >= 500 },
    );
  }
}

class DuplicateDelivery extends Error {}
