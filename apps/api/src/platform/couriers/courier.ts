/**
 * A courier that collects an order from the shop and takes it to the customer.
 *
 * One interface, two implementations: DoorDash Drive, and a simulation for a
 * server without DoorDash credentials. The order code never knows which it is
 * talking to, which is what lets the whole delivery flow be built and tested
 * before the shop has its API access -- and means switching to the real thing
 * is configuration, not code.
 */

export interface CourierDeliveryRequest {
  /** This system's id for the delivery. The courier echoes it back in every webhook. */
  externalDeliveryId: string;
  pickup: {
    businessName: string;
    /** One line, as couriers take it: "123 Main St, Harker Heights, TX 76548". */
    address: string;
    phone: string | null;
    instructions: string | null;
    /** What the driver reads out at the counter: "Order HH01-260916-004". */
    referenceTag: string;
  };
  dropoff: {
    address: string;
    phone: string;
    givenName: string;
    familyName: string;
    instructions: string | null;
  };
  orderValueMinor: bigint;
  /**
   * Tobacco and nicotine in the bag. The courier checks the recipient's ID and
   * takes a signature at the door, and returns the order if it cannot.
   */
  containsTobacco: boolean;
  containsHemp: boolean;
}

export interface CourierDelivery {
  externalDeliveryId: string;
  /** The courier's own status word, kept as it said it. */
  status: string;
  /** What the courier charges the shop, when it says. */
  feeMinor: bigint | null;
  trackingUrl: string | null;
  supportReference: string | null;
  estimatedPickupAt: string | null;
  estimatedDropoffAt: string | null;
}

export interface CourierQuote {
  feeMinor: bigint | null;
  estimatedDropoffAt: string | null;
}

/**
 * The courier said no, for a reason a customer or a member of staff can act on
 * -- an address it does not serve, an order it will not carry. Distinct from
 * the courier being unreachable, which is a fault and is retried.
 */
export class CourierRefusal extends Error {
  constructor(
    /** Safe to show the person who asked. */
    readonly userMessage: string,
    /** The courier's own words, for the back office. */
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'CourierRefusal';
  }
}

export interface Courier {
  /** Recorded on each delivery: 'doordash' or 'simulated'. */
  readonly name: string;
  /** What customers are told is bringing their order. */
  readonly displayName: string;
  readonly simulated: boolean;
  /** Whether the courier will take this delivery, and roughly what and when -- without booking anything. */
  quote(request: CourierDeliveryRequest): Promise<CourierQuote>;
  /** Book a driver. Asking again with the same external id returns the same delivery. */
  createDelivery(request: CourierDeliveryRequest): Promise<CourierDelivery>;
  cancelDelivery(externalDeliveryId: string): Promise<void>;
}
