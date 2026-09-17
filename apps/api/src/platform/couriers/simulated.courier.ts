import type { Courier, CourierDelivery, CourierDeliveryRequest, CourierQuote } from './courier.js';

/** What a simulated driver "charges" the shop. A placeholder, shown as simulated wherever it appears. */
const SIMULATED_FEE_MINOR = 699n;

/**
 * Deliveries that go nowhere, for a server without courier credentials.
 *
 * Booking a driver succeeds and nothing else happens by itself: the order
 * stays waiting for a driver until someone presses one of the back office's
 * "simulate" buttons, which feed their report through exactly the code a real
 * DoorDash webhook takes. Every screen that shows one of these says it was
 * simulated, so nobody waits at the door for it.
 */
export class SimulatedCourier implements Courier {
  readonly name = 'simulated';
  readonly displayName = 'DoorDash (simulated)';
  readonly simulated = true;

  async quote(_request: CourierDeliveryRequest): Promise<CourierQuote> {
    return { feeMinor: SIMULATED_FEE_MINOR, estimatedDropoffAt: minutesFromNow(45) };
  }

  async createDelivery(request: CourierDeliveryRequest): Promise<CourierDelivery> {
    return {
      externalDeliveryId: request.externalDeliveryId,
      status: 'created',
      feeMinor: SIMULATED_FEE_MINOR,
      trackingUrl: null,
      supportReference: `SIM-${request.externalDeliveryId.slice(-8).toUpperCase()}`,
      estimatedPickupAt: minutesFromNow(15),
      estimatedDropoffAt: minutesFromNow(45),
    };
  }

  async cancelDelivery(_externalDeliveryId: string): Promise<void> {}
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
