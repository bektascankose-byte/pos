import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorDashDriveCourier } from './doordash-drive.courier.js';
import { CourierRefusal, type CourierDeliveryRequest } from './courier.js';

const credentials = {
  developerId: 'dev',
  keyId: 'key',
  signingSecret: Buffer.from('secret-for-tests').toString('base64url'),
};

const request: CourierDeliveryRequest = {
  externalDeliveryId: 'snappos-01a0acf1',
  pickup: {
    businessName: 'HH Smoke & Vape',
    address: '100 Example Rd, Harker Heights, TX 76548',
    phone: '+12545550100',
    instructions: 'Ask at the counter',
    referenceTag: 'Order HH01-260917-001',
  },
  dropoff: {
    address: '200 Sample St, Killeen, TX 76542',
    phone: '+12545550199',
    givenName: 'Sam',
    familyName: 'Tester',
    instructions: null,
  },
  orderValueMinor: 4328n,
  containsTobacco: true,
  containsHemp: false,
};

function fakeFetch(responses: { status: number; body: unknown }[], seen: { url: string; init: RequestInit }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('an age-restricted delivery asks for an ID check and a signature, and comes back if undeliverable', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const courier = new DoorDashDriveCourier(
    credentials,
    fakeFetch([{ status: 200, body: { external_delivery_id: 'snappos-01a0acf1', delivery_status: 'created', fee: 975, tracking_url: 'https://track.example/abc' } }], seen),
  );

  const delivery = await courier.createDelivery(request);
  assert.equal(delivery.feeMinor, 975n);
  assert.equal(delivery.trackingUrl, 'https://track.example/abc');

  assert.equal(seen[0]!.url, 'https://openapi.doordash.com/drive/v2/deliveries');
  assert.match(String((seen[0]!.init.headers as Record<string, string>).Authorization), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.deepEqual(body.order_contains, { tobacco: true, hemp: false });
  assert.deepEqual(body.dropoff_options, { id_verification: 'required', signature: 'required' });
  assert.equal(body.action_if_undeliverable, 'return_to_pickup');
  assert.equal(body.contactless_dropoff, false);
  assert.equal(body.order_value, 4328);
});

test('booking the same delivery twice returns the one already booked', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const courier = new DoorDashDriveCourier(
    credentials,
    fakeFetch(
      [
        { status: 409, body: { code: 'duplicate_delivery_id' } },
        { status: 200, body: { external_delivery_id: 'snappos-01a0acf1', delivery_status: 'enroute_to_pickup' } },
      ],
      seen,
    ),
  );
  const delivery = await courier.createDelivery(request);
  assert.equal(delivery.status, 'enroute_to_pickup');
  assert.equal(seen[1]!.init.method, 'GET');
});

test("an address DoorDash won't serve is a refusal with words for the customer", async () => {
  const courier = new DoorDashDriveCourier(credentials, fakeFetch([{ status: 422, body: { message: 'outside delivery area' } }], []));
  await assert.rejects(courier.createDelivery(request), (e: unknown) => {
    assert.ok(e instanceof CourierRefusal);
    assert.match(e.userMessage, /can't deliver this order to that address/);
    return true;
  });
});

test('an order with nothing age-restricted asks for no ID check', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const courier = new DoorDashDriveCourier(credentials, fakeFetch([{ status: 200, body: { fee: 500 } }], seen));
  await courier.quote({ ...request, containsTobacco: false });
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.equal(body.dropoff_options, undefined);
  assert.notEqual(body.external_delivery_id, request.externalDeliveryId);
});
