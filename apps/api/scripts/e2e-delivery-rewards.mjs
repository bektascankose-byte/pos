#!/usr/bin/env node
/**
 * Points, phones and deliveries, end to end.
 *
 * Loyalty points earned at the counter and online, taken back by refunds and
 * voids, and never earned on what the program excludes. An online account that
 * proves a phone number by text becoming the in-store rewards member the
 * register knows by that number. And a delivery order from the cart to the
 * door: the delivery area and fee, the age check and the held payment at
 * checkout, a driver booked, the courier's reports -- simulated, and through
 * DoorDash's webhook -- the sale written with its delivery fee, and what
 * happens when a delivery comes back. Last, the brand banners the back office
 * puts on the website, which only show while what they advertise can be bought.
 *
 * Imported by e2e.mjs after the website checks, sharing their server and reset.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const SHOP_KEY = 'shop_dev_only_not_a_secret';
export const E2E_DOORDASH_AUTHORIZATION = 'Basic ZTJlOmRvb3JkYXNoLXdlYmhvb2s=';

export async function runDeliveryAndRewardsChecks({
  api,
  base,
  check,
  uuidV7,
  ownerToken,
  managerToken,
  cashierToken,
  storeId,
  mailbox,
}) {
  // ------------------------------------------------------------------ context

  const shop = (path, { cart, session, key = SHOP_KEY, headers = {}, ...rest } = {}) =>
    api(`/api/v1/shop${path}`, {
      ...rest,
      headers: {
        ...(key ? { 'x-shop-key': key } : {}),
        ...(cart ? { 'x-cart-token': cart } : {}),
        ...(session ? { 'x-customer-session': session } : {}),
        ...headers,
      },
    });

  const whoIs = async (token) => (await api('/api/v1/auth/session', { token })).body;
  const owner = await whoIs(ownerToken);
  const managerId = (await whoIs(managerToken))?.user_id;
  const cashierId = (await whoIs(cashierToken))?.user_id;
  const orgId = owner?.org_id;
  const registerId = (await api('/api/v1/registers', { token: ownerToken })).body?.data?.[0]?.id;

  const variantFor = async (upc) => {
    const r = await api(`/api/v1/catalog/scan/${upc}?store_id=${storeId}`, { token: cashierToken });
    return { variantId: r.body?.variant_id, productId: r.body?.product_id };
  };
  const levelOf = async (variantId) => {
    const r = await api(`/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`, { token: ownerToken });
    return Number(r.body?.[0]?.on_hand ?? NaN);
  };

  const mail = () => readdirSync(mailbox).map((name) => ({ name, text: readFileSync(join(mailbox, name), 'utf8') }));
  const waitForMail = async (matches, ms = 10_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = mail().filter((m) => matches(m));
      if (found.length > 0) return found;
      await sleep(250);
    }
    return [];
  };
  const tokenIn = (text, path) => new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];
  const codeFor = async (phone, seen) => {
    const texts = await waitForMail((m) => m.name.endsWith('.txt') && m.text.includes(`To: ${phone}`) && !seen.has(m.name));
    const latest = texts.sort((a, b) => a.name.localeCompare(b.name)).at(-1);
    if (latest) seen.add(latest.name);
    return { code: /code is (\d{6})/.exec(latest?.text ?? '')?.[1], text: latest?.text ?? '' };
  };

  const direct = new pg.Pool({
    connectionString:
      process.env.E2E_DATABASE_URL ?? 'postgres://snappos_app:dev_only_not_a_secret@localhost:5432/snappos_e2e',
  });
  const sql = async (text, params = []) => {
    const client = await direct.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const { rows } = await client.query(text, params);
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const papers = await variantFor('716165174233'); // $2.99, no age limit
  const lostMaryBlue = await variantFor('810082310014'); // $19.99, a vape
  const pineapple = await variantFor('810082310021'); // $19.99, a vape, 9 on hand

  let sequence = 9000;
  const ringSale = async ({ customerId, lines }) => {
    const saleId = uuidV7();
    const at = new Date().toISOString();
    const saleLines = lines.map((line, index) => ({
      id: uuidV7(),
      line_no: index + 1,
      variant_id: line.variantId,
      description: line.description,
      sku_snapshot: line.sku,
      quantity: String(line.quantity),
      unit_price_minor: String(line.price),
      original_price_minor: String(line.price),
      tax_minor: String(line.tax),
      total_minor: String(line.price * line.quantity + line.tax),
      unit_cost: '1.000000',
    }));
    const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
    const tax = lines.reduce((sum, line) => sum + line.tax, 0);
    sequence += 1;
    const envelope = {
      register_id: registerId,
      device_id: uuidV7(),
      entities: [
        {
          id: saleId,
          entity_type: 'sale',
          device_time: at,
          payload: {
            store_id: storeId,
            register_id: registerId,
            cashier_user_id: cashierId,
            customer_id: customerId,
            receipt_no: `HH01-R1-L${sequence}`,
            register_sequence: sequence,
            status: 'completed',
            subtotal_minor: String(subtotal),
            tax_minor: String(tax),
            total_minor: String(subtotal + tax),
            device_time: at,
            completed_at: at,
            lines: saleLines,
            payments: [{ id: uuidV7(), method: 'card', amount_minor: String(subtotal + tax), device_time: at }],
            age_verifications: [],
          },
        },
      ],
    };
    const upload = await api('/api/v1/sync/batch', { token: cashierToken, method: 'POST', body: envelope });
    return { saleId, lines: saleLines, status: upload.body?.results?.[0]?.status, upload, envelope };
  };
  const paperLine = (quantity, tax) => ({
    variantId: papers.variantId, description: 'RAW Classic King Size Slim', sku: 'RAW-KSS', price: 299, quantity, tax,
  });
  const loyaltyOf = async (customerId) => (await api(`/api/v1/customers/${customerId}/loyalty`, { token: ownerToken })).body;

  // --------------------------------------------------- 1. points at the counter

  const casey = await api('/api/v1/customers', {
    token: ownerToken,
    method: 'POST',
    body: { first_name: 'Casey', last_name: 'Morgan', phone: '+12545550123' },
  });
  const caseyId = casey.body?.id;
  check('an in-store rewards member is known by their phone', casey.status === 201 && typeof caseyId === 'string',
        `${casey.status} ${JSON.stringify(casey.body)}`);

  const beforeProgram = await ringSale({ customerId: caseyId, lines: [paperLine(1, 25)] });
  check(
    'a sale earns nothing while the program is switched off',
    beforeProgram.status === 'accepted' && (await loyaltyOf(caseyId))?.points === 0,
    JSON.stringify(beforeProgram.upload.body),
  );

  const switchedOn = await api('/api/v1/loyalty/settings', {
    token: ownerToken,
    method: 'PATCH',
    body: { is_active: true, earn_points_per_dollar: '1', excluded_regulated_classes: ['cigarette', 'smokeless', 'ends'] },
  });
  check('the owner switches the program on', switchedOn.status === 200 && switchedOn.body?.is_active === true,
        `${switchedOn.status} ${JSON.stringify(switchedOn.body)}`);

  // Ten papers ($29.90) and a vape ($19.99), with vapes excluded: 29 points, not 49.
  const counterSale = await ringSale({
    customerId: caseyId,
    lines: [
      paperLine(10, 247),
      { variantId: lostMaryBlue.variantId, description: 'Lost Mary BM6000 — Blueberry Ice', sku: 'LM-BM6000-BB', price: 1999, quantity: 1, tax: 165 },
    ],
  });
  const afterSale = await loyaltyOf(caseyId);
  check(
    'a counter sale earns a point a dollar, and nothing on a class the program excludes',
    counterSale.status === 'accepted' && afterSale?.points === 29 && afterSale?.entries?.[0]?.kind === 'earn',
    JSON.stringify(afterSale),
  );

  const replayed = await api('/api/v1/sync/batch', { token: cashierToken, method: 'POST', body: counterSale.envelope });
  check(
    'a replayed upload of the same sale earns nothing more',
    replayed.body?.results?.[0]?.status === 'duplicate' && (await loyaltyOf(caseyId))?.points === 29,
    JSON.stringify(replayed.body?.results?.[0]),
  );

  // Five papers back: $14.95 of what earned, 14 points.
  const refund = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: {
      register_id: registerId,
      device_id: uuidV7(),
      entities: [
        {
          id: uuidV7(),
          entity_type: 'refund',
          device_time: new Date().toISOString(),
          payload: {
            store_id: storeId,
            register_id: registerId,
            original_sale_id: counterSale.saleId,
            cashier_user_id: cashierId,
            approved_by: managerId,
            receipt_no: `HH01-R1-LR${Date.now() % 100000}`,
            reason_code: 'customer_changed_mind',
            subtotal_minor: '1495',
            tax_minor: '123',
            total_minor: '1618',
            device_time: new Date().toISOString(),
            lines: [
              {
                id: uuidV7(),
                sale_line_id: counterSale.lines[0].id,
                variant_id: papers.variantId,
                description: 'RAW Classic King Size Slim',
                quantity: '5',
                unit_price_minor: '299',
                tax_minor: '123',
                total_minor: '1618',
                unit_cost: '1.000000',
                restocked: true,
              },
            ],
            payments: [{ id: uuidV7(), method: 'card', amount_minor: '1618', device_time: new Date().toISOString() }],
          },
        },
      ],
    },
  });
  check(
    'a refund takes back the points the returned goods earned',
    refund.body?.results?.[0]?.status === 'accepted' && (await loyaltyOf(caseyId))?.points === 15,
    `${JSON.stringify(refund.body?.results?.[0])} points ${(await loyaltyOf(caseyId))?.points}`,
  );

  const voidable = await ringSale({ customerId: caseyId, lines: [paperLine(3, 74)] });
  const beforeVoid = (await loyaltyOf(caseyId))?.points;
  await api(`/api/v1/sales/${voidable.saleId}/void`, { token: managerToken, method: 'POST', body: { reason: 'rang it twice' } });
  check(
    'a voided sale takes back everything it earned',
    beforeVoid === 23 && (await loyaltyOf(caseyId))?.points === 15,
    `before void ${beforeVoid}, after ${(await loyaltyOf(caseyId))?.points}`,
  );

  const cashierAdjust = await api(`/api/v1/customers/${caseyId}/loyalty/adjustments`, {
    token: cashierToken, method: 'POST', body: { points: 100, note: 'Just because' },
  });
  const unexplained = await api(`/api/v1/customers/${caseyId}/loyalty/adjustments`, {
    token: ownerToken, method: 'POST', body: { points: 5, note: '' },
  });
  const adjusted = await api(`/api/v1/customers/${caseyId}/loyalty/adjustments`, {
    token: ownerToken, method: 'POST', body: { points: 5, note: 'Birthday bonus' },
  });
  check(
    'a cashier cannot hand out points, and a manager correction has to say why',
    cashierAdjust.status === 403 && unexplained.status === 400 && adjusted.status === 201 && adjusted.body?.points === 20,
    `${cashierAdjust.status} ${unexplained.status} ${adjusted.status} ${JSON.stringify(adjusted.body)}`,
  );

  await api('/api/v1/loyalty/settings', {
    token: ownerToken,
    method: 'PATCH',
    body: { excluded_regulated_classes: ['cigarette', 'smokeless'] },
  });

  // ------------------------------------------- 2. an online account proves its phone
  const texted = new Set();

  const caseyOnline = { first_name: 'Casey', last_name: 'Morgan', email: 'casey@example.test', password: 'a long casey passphrase' };
  const signUp = await shop('/account/register', {
    method: 'POST',
    body: { ...caseyOnline, phone: '(254) 555-0123', age_attested: true },
  });
  const badPhone = await shop('/account/register', {
    method: 'POST',
    body: { ...caseyOnline, email: 'other@example.test', phone: '555-0123', age_attested: true },
  });
  check('signing up can give a rewards phone, and a number that is not one is refused',
        signUp.status === 202 && badPhone.status === 400, `${signUp.status} ${badPhone.status}`);

  const caseyVerify = await waitForMail((m) => m.text.includes('To: casey@example.test') && m.text.includes('/account/verify?token='));
  const caseySignedIn = await shop('/account/verify-email', {
    method: 'POST',
    body: { token: tokenIn(caseyVerify[0]?.text ?? '', '/account/verify') },
  });
  const caseySession = caseySignedIn.body?.session_token;
  const firstCode = await codeFor('+12545550123', texted);
  check(
    'confirming the email texts a code to the rewards phone, without linking anything yet',
    caseySignedIn.status === 200 && /^\d{6}$/.test(firstCode.code ?? '') && caseySignedIn.body?.customer?.phone === null,
    `${caseySignedIn.status} ${JSON.stringify(caseySignedIn.body?.customer)} code ${firstCode.code}`,
  );
  check(
    'the text says nothing about what the shop sells, so carriers do not filter it',
    firstCode.text && !/vape|smoke|tobacco|nicotine/i.test(firstCode.text),
    firstCode.text,
  );

  const pending = await shop('/account/me', { session: caseySession });
  check('the account shows which phone is waiting for its code, by its last four digits only',
        pending.body?.pending_phone_hint === 'ending in 0123' && pending.body?.phone_verified === false,
        JSON.stringify(pending.body));

  const tooSoon = await shop('/account/me/phone', { session: caseySession, method: 'POST', body: { phone: '254-555-0123' } });
  check('another code cannot be asked for straight away', tooSoon.status === 429, `${tooSoon.status} ${JSON.stringify(tooSoon.body)}`);

  const wrongCode = firstCode.code === '000000' ? '111111' : '000000';
  const wrong = await shop('/account/me/phone/verify', { session: caseySession, method: 'POST', body: { code: wrongCode } });
  check('a wrong code is refused, saying how many tries are left', wrong.status === 400 && /4 tries left/.test(wrong.body?.message ?? ''),
        `${wrong.status} ${JSON.stringify(wrong.body)}`);

  const linked = await shop('/account/me/phone/verify', { session: caseySession, method: 'POST', body: { code: firstCode.code } });
  check(
    'the right code links the account to the in-store rewards member, points and all',
    linked.status === 200 &&
      linked.body?.linked_in_store_rewards === true &&
      linked.body?.rewards?.points === 20 &&
      linked.body?.rewards?.phone === '+12545550123' &&
      linked.body?.rewards?.phone_verified === true,
    `${linked.status} ${JSON.stringify(linked.body)}`,
  );

  const caseyMe = await shop('/account/me', { session: caseySession });
  const staffSearch = await api(`/api/v1/customers?phone=${encodeURIComponent('+12545550123')}`, { token: cashierToken });
  check(
    'the same session carries on, now as the one customer the register also finds by phone',
    caseyMe.status === 200 &&
      caseyMe.body?.email === 'casey@example.test' &&
      staffSearch.body?.data?.length === 1 &&
      staffSearch.body.data[0].id === caseyId &&
      staffSearch.body.data[0].email === 'casey@example.test',
    `${JSON.stringify(caseyMe.body)} / ${JSON.stringify(staffSearch.body?.data)}`,
  );
  const caseyLoyalty = await loyaltyOf(caseyId);
  check('the back office sees the member has an online account with a proven phone',
        caseyLoyalty?.has_online_account === true && caseyLoyalty?.phone_verified === true, JSON.stringify(caseyLoyalty));

  const rewardsPage = await shop('/account/me/rewards', { session: caseySession });
  check(
    "the customer's rewards list the counter sale in plain words",
    rewardsPage.status === 200 && rewardsPage.body?.activity?.some((a) => a.kind === 'earn' && /^In store, receipt HH01-R1-L/.test(a.label)),
    JSON.stringify(rewardsPage.body?.activity),
  );

  const jamie = { first_name: 'Jamie', last_name: 'Reyes', email: 'jamie@example.test', password: 'jamie long passphrase' };
  await shop('/account/register', { method: 'POST', body: { ...jamie, phone: '2545550123', age_attested: true } });
  const jamieVerify = await waitForMail((m) => m.text.includes('To: jamie@example.test') && m.text.includes('/account/verify?token='));
  const jamieSignedIn = await shop('/account/verify-email', {
    method: 'POST',
    body: { token: tokenIn(jamieVerify[0]?.text ?? '', '/account/verify') },
  });
  const jamieCode = await codeFor('+12545550123', texted);
  const taken = await shop('/account/me/phone/verify', {
    session: jamieSignedIn.body?.session_token,
    method: 'POST',
    body: { code: jamieCode.code },
  });
  check(
    "a phone already on another online account cannot be taken over, even with that phone's code",
    taken.status === 409 && /another online account/i.test(taken.body?.message ?? ''),
    `${taken.status} ${JSON.stringify(taken.body)}`,
  );

  // ------------------------------------------ 3. delivery is off until the shop turns it on

  const offInfo = await shop('/info');
  const earlyCart = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  const earlySwitch = await shop('/cart/fulfilment', { cart: earlyCart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76542' } });
  check(
    'until the shop switches delivery on, the website offers pickup only',
    offInfo.body?.delivery?.enabled === false && earlySwitch.status === 409,
    `${JSON.stringify(offInfo.body?.delivery)} ${earlySwitch.status}`,
  );

  const deliverySettings = { enabled: true, postal_codes: ['76548', '76542', '76548'], fee_minor: '499', free_over_minor: '10000', minimum_subtotal_minor: '1500' };
  const managerDelivery = await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: managerToken, method: 'PATCH', body: deliverySettings });
  const ownerDelivery = await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: ownerToken, method: 'PATCH', body: deliverySettings });
  check(
    'only the owner decides where the shop delivers',
    managerDelivery.status === 403 &&
      ownerDelivery.status === 200 &&
      JSON.stringify(ownerDelivery.body?.postal_codes) === JSON.stringify(['76542', '76548']) &&
      ownerDelivery.body?.courier_mode === 'simulated',
    `${managerDelivery.status} ${ownerDelivery.status} ${JSON.stringify(ownerDelivery.body)}`,
  );
  check(
    'the back office is told, in words, what still stands in the way',
    ownerDelivery.body?.problems?.some((p) => /selling rule allows delivery/.test(p)) &&
      ownerDelivery.body?.problems?.some((p) => /listed for delivery/.test(p)) &&
      ownerDelivery.body?.problems?.some((p) => /simulated/.test(p)),
    JSON.stringify(ownerDelivery.body?.problems),
  );

  const deliveryRule = await api('/api/v1/compliance/rules', {
    token: ownerToken,
    method: 'POST',
    body: {
      name: 'E2E: delivery allowed',
      effect: 'allow',
      channel: 'delivery',
      authority_note: 'End to end check of local delivery within the delivery area.',
    },
  });
  await api(`/api/v1/storefront/listings/${pineapple.variantId}`, {
    token: ownerToken, method: 'POST', body: { availability: 'pickup_and_delivery' },
  });
  const held = await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: ownerToken });
  check(
    'a rule and a listing are not enough, and the shop is told exactly what is still in the way',
    deliveryRule.status === 201 &&
      !held.body?.problems?.some((p) => /No selling rule allows delivery/.test(p)) &&
      !held.body?.problems?.some((p) => /No products are listed for delivery/.test(p)) &&
      held.body?.problems?.some((p) => /Delivery of ENDS requires review/.test(p)),
    `${deliveryRule.status} ${JSON.stringify(held.body?.problems)}`,
  );

  // The platform ships that rule denying until counsel has reviewed it, and a
  // deny ends an evaluation wherever it appears -- so the allow above cannot
  // outweigh it and the shop cannot end it. It lifts it instead, on record.
  const allRules = await api('/api/v1/compliance/rules', { token: ownerToken });
  const endsDelivery = allRules.body?.find(
    (rule) => rule.platform && rule.name === 'Delivery of ENDS requires review',
  );
  const attestation = {
    counsel_reviewed_on: '2026-09-01',
    permit_reference: 'TX e-cigarette retailer permit 1234567',
    authority_note: 'Counsel reviewed 2026-09-01: the permit covers delivery sales inside the listed ZIP codes.',
  };
  const liftPath = `/api/v1/compliance/rules/${endsDelivery?.id}/lift`;
  const managerLift = await api(liftPath, { token: managerToken, method: 'POST', body: attestation });
  const thinLift = await api(liftPath, {
    token: ownerToken, method: 'POST', body: { ...attestation, authority_note: 'ok' },
  });
  const futureReview = await api(liftPath, {
    token: ownerToken, method: 'POST', body: { ...attestation, counsel_reviewed_on: '2099-01-01' },
  });
  const ownRuleLift = await api(`/api/v1/compliance/rules/${deliveryRule.body?.id}/lift`, {
    token: ownerToken, method: 'POST', body: attestation,
  });
  check(
    'a lift takes an owner and a real attestation, and a shop lifts only the platform\'s rules',
    managerLift.status === 403 && thinLift.status === 400 &&
      futureReview.status >= 400 && futureReview.status < 500 && ownRuleLift.status === 400,
    `${managerLift.status} ${thinLift.status} ${futureReview.status} ${ownRuleLift.status}`,
  );

  const lift = await api(liftPath, { token: ownerToken, method: 'POST', body: attestation });
  const liftAgain = await api(liftPath, { token: ownerToken, method: 'POST', body: attestation });
  check(
    'the owner lifts it once, and the permit it was lifted under is kept with the rule',
    lift.status === 201 &&
      lift.body?.lift?.permit_reference === attestation.permit_reference &&
      lift.body?.lift?.counsel_reviewed_on === '2026-09-01' &&
      liftAgain.status === 409,
    `${lift.status} ${JSON.stringify(lift.body?.lift)} ${liftAgain.status}`,
  );

  const readyToDeliver = await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: ownerToken });
  check(
    'once the hold is lifted, nothing stands in the way of delivery but the simulated providers',
    !readyToDeliver.body?.problems?.some((p) => /No selling rule|No products are listed|ENDS|may actually be sold/.test(p)),
    JSON.stringify(readyToDeliver.body?.problems),
  );

  const onInfo = await shop('/info');
  const forDelivery = await shop('/products?fulfilment=delivery&page_size=48');
  check(
    'the website offers delivery, and lists only what may be delivered',
    onInfo.body?.delivery?.enabled === true &&
      onInfo.body?.delivery?.simulated === true &&
      forDelivery.body?.items?.some((card) => card.id === pineapple.productId) &&
      !forDelivery.body?.items?.some((card) => card.id === papers.productId),
    `${JSON.stringify(onInfo.body?.delivery)} ${JSON.stringify(forDelivery.body?.items?.map((c) => c.name))}`,
  );

  // --------------------------------------------------------- 4. a delivery cart

  const cart = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  await shop(`/cart/lines/${pineapple.variantId}`, { cart, method: 'POST', body: { quantity: 1 } });
  const toDelivery = await shop('/cart/fulfilment', { cart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76542' } });
  // $19.99 with a $4.99 fee: 8.25% of each is $1.65 and $0.41, so $27.04.
  check(
    'a delivery cart adds the fee and the tax on it',
    toDelivery.status === 200 &&
      toDelivery.body?.fulfilment === 'delivery' &&
      toDelivery.body?.subtotal_minor === '1999' &&
      toDelivery.body?.delivery_fee_minor === '499' &&
      toDelivery.body?.estimated_tax_minor === '206' &&
      toDelivery.body?.estimated_total_minor === '2704' &&
      toDelivery.body?.can_checkout === true,
    JSON.stringify(toDelivery.body),
  );

  const faraway = await shop('/cart/fulfilment', { cart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '78701' } });
  check(
    'an address outside the delivery area is refused, suggesting pickup',
    faraway.body?.can_checkout === false && /don't deliver to 78701/.test(faraway.body?.delivery_problem ?? ''),
    JSON.stringify(faraway.body),
  );
  await shop('/cart/fulfilment', { cart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76542' } });

  const papersForDelivery = await shop(`/cart/lines/${papers.variantId}`, { cart, method: 'POST', body: { quantity: 1 } });
  check(
    'an item listed for pickup only cannot go in a delivery cart',
    papersForDelivery.status === 409 && /isn't available for delivery/.test(papersForDelivery.body?.message ?? ''),
    `${papersForDelivery.status} ${JSON.stringify(papersForDelivery.body)}`,
  );

  await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: ownerToken, method: 'PATCH', body: { minimum_subtotal_minor: '2500' } });
  const underMinimum = await shop('/cart', { cart });
  check('a delivery below the minimum order says how much more is needed',
        /start at \$25\.00/.test(underMinimum.body?.delivery_problem ?? ''), JSON.stringify(underMinimum.body?.delivery_problem));
  await api(`/api/v1/delivery/settings?store_id=${storeId}`, { token: ownerToken, method: 'PATCH', body: { minimum_subtotal_minor: '1500' } });

  // --------------------------------------------------------- 5. delivery checkout

  const guest = { first_name: 'Morgan', last_name: 'Lee', email: 'morgan@example.test' };
  const address = { address_line1: '200 Sample St', city: 'Killeen', region: 'tx', postal_code: '76542', dropoff_instructions: 'Blue door' };
  const checkout = (extra) => shop('/checkout', { cart, method: 'POST', body: { contact: guest, age_attested: true, ...extra } });

  const noAddress = await checkout({ payment_token: 'test-approve' });
  check('a delivery order needs an address', noAddress.status === 400 && /delivery address/i.test(noAddress.body?.message ?? ''),
        `${noAddress.status} ${JSON.stringify(noAddress.body)}`);

  const failedChecksBefore = (await sql(`SELECT count(*)::int AS n FROM age_verifications WHERE result = 'fail'`))[0].n;
  const tooYoung = await checkout({
    delivery: { address, phone: '(254) 555-0199', date_of_birth: '2010-01-01' },
    payment_token: 'test-approve',
  });
  const failedChecksAfter = (await sql(`SELECT count(*)::int AS n FROM age_verifications WHERE result = 'fail'`))[0].n;
  check(
    'a buyer under 21 is refused before any card is touched, and the refusal is recorded',
    tooYoung.status === 400 && /21 or older/.test(tooYoung.body?.message ?? '') && failedChecksAfter === failedChecksBefore + 1,
    `${tooYoung.status} ${JSON.stringify(tooYoung.body)} fails ${failedChecksBefore} -> ${failedChecksAfter}`,
  );

  const adult = { address, phone: '(254) 555-0199', date_of_birth: '1990-05-20' };
  const declined = await checkout({ delivery: adult, payment_token: 'test-decline' });
  check('a declined card places no order', declined.status === 400 && /declined/i.test(declined.body?.message ?? ''),
        `${declined.status} ${JSON.stringify(declined.body)}`);

  const placed = await checkout({ delivery: adult, payment_token: 'test-approve' });
  const orderNumber = placed.body?.order_number;
  const trackingToken = placed.body?.tracking_token;
  check('a guest can order for delivery', placed.status === 201 && placed.body?.status === 'placed',
        `${placed.status} ${JSON.stringify(placed.body)}`);

  const again = await checkout({ delivery: adult, payment_token: 'test-approve' });
  const [heldPayments] = await sql(
    `SELECT count(*)::int AS live, max(amount_minor)::text AS amount
     FROM order_payments p JOIN orders o ON o.id = p.order_id
     WHERE o.order_number = $1 AND p.status IN ('authorized', 'captured')`,
    [orderNumber],
  );
  check(
    'pressing Place Order twice holds the money once, for the total the customer saw',
    again.body?.order_number === orderNumber && heldPayments.live === 1 && heldPayments.amount === '2704',
    `${JSON.stringify(again.body)} ${JSON.stringify(heldPayments)}`,
  );

  const tracked = await shop(`/orders/track/${trackingToken}`);
  check(
    'the tracking page shows where it is going by town only, with the fee and the payment held',
    tracked.status === 200 &&
      tracked.body?.fulfilment === 'delivery' &&
      tracked.body?.delivery?.city === 'Killeen' &&
      tracked.body?.delivery?.postal_code === '76542' &&
      tracked.body?.delivery?.simulated === true &&
      tracked.body?.delivery_fee_minor === '499' &&
      tracked.body?.total_minor === '2704' &&
      tracked.body?.payment?.status === 'authorized' &&
      !JSON.stringify(tracked.body).includes('200 Sample St') &&
      !JSON.stringify(tracked.body).includes('555'),
    JSON.stringify(tracked.body),
  );

  const [ageCheck] = await sql(
    `SELECT a.method::text, a.result::text, a.provider FROM age_verifications a
     JOIN orders o ON o.id = a.order_id WHERE o.order_number = $1`,
    [orderNumber],
  );
  check('the age check is kept against the order: that it passed and who checked, nothing from the ID',
        ageCheck?.method === 'provider' && ageCheck?.result === 'pass' && ageCheck?.provider === 'test', JSON.stringify(ageCheck));

  const confirmation = await waitForMail((m) => m.text.includes(`We got your order ${orderNumber}`));
  check(
    'the confirmation says the money is held and the driver will check ID',
    confirmation.length === 1 &&
      confirmation[0].text.includes('held on your card') &&
      confirmation[0].text.includes('driver checks photo ID'),
    confirmation[0]?.text,
  );

  // --------------------------------------------------- 6. from the shelf to the door

  const queue = await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken });
  const queued = queue.body?.find((entry) => entry.order_number === orderNumber);
  check('the delivery order reaches the counter, paid online and going to 76542',
        queued?.fulfilment === 'delivery' && queued?.paid_online === true && queued?.delivery_postal_code === '76542',
        JSON.stringify(queued));

  const orderId = queued?.id;
  const tooEarly = await api(`/api/v1/orders/${orderId}/dispatch`, { token: cashierToken, method: 'POST' });
  check('a driver is not booked before the order is packed', tooEarly.status === 409, `${tooEarly.status}`);

  await api(`/api/v1/orders/${orderId}/accept`, { token: cashierToken, method: 'POST' });
  await api(`/api/v1/orders/${orderId}/ready`, { token: cashierToken, method: 'POST' });
  await sleep(1500);
  check('a packed delivery order sends no "ready to pick up" email',
        !mail().some((m) => m.text.includes(`${orderNumber} is ready to pick up`)));

  const dispatched = await api(`/api/v1/orders/${orderId}/dispatch`, { token: cashierToken, method: 'POST' });
  check(
    'staff book a driver for the packed order',
    dispatched.status === 201 &&
      dispatched.body?.status === 'courier_requested' &&
      dispatched.body?.delivery?.provider === 'simulated' &&
      /^snappos-/.test(dispatched.body?.delivery?.external_delivery_id ?? ''),
    `${dispatched.status} ${JSON.stringify(dispatched.body?.delivery)}`,
  );

  const cancelWithDriver = await api(`/api/v1/orders/${orderId}/cancel`, { token: ownerToken, method: 'POST', body: { reason: 'changed mind' } });
  const handedOverByStaff = await api(`/api/v1/orders/${orderId}/complete`, { token: cashierToken, method: 'POST', body: { tender: 'cash', id_checked: true } });
  check(
    "an order with a driver booked cannot be cancelled from under the driver, nor marked delivered by staff",
    cancelWithDriver.status === 409 && handedOverByStaff.status === 409,
    `${cancelWithDriver.status} ${JSON.stringify(cancelWithDriver.body)} / ${handedOverByStaff.status} ${JSON.stringify(handedOverByStaff.body)}`,
  );

  const stockBefore = await levelOf(pineapple.variantId);
  const pickedUp = await api(`/api/v1/orders/${orderId}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'picked_up' } });
  check('when the driver collects it, the order is on its way',
        pickedUp.status === 201 && pickedUp.body?.status === 'in_transit' && pickedUp.body?.delivery?.driver_first_name === 'Sam',
        `${pickedUp.status} ${JSON.stringify(pickedUp.body?.delivery)}`);
  const onItsWay = await waitForMail((m) => m.text.includes(`${orderNumber} is on its way`));
  check('the customer is told it is on its way', onItsWay.length === 1, `${onItsWay.length} emails`);
  check('stock has still not moved while the order is on the road', (await levelOf(pineapple.variantId)) === stockBefore);

  const delivered = await api(`/api/v1/orders/${orderId}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'delivered' } });
  check('when the driver hands it over, the order is complete', delivered.body?.status === 'completed' && typeof delivered.body?.sale_id === 'string',
        `${delivered.status} ${JSON.stringify(delivered.body)}`);

  const [sale] = await sql(
    `SELECT s.total_minor::text AS total, s.tax_minor::text AS tax, s.channel::text AS channel, s.price_variance_minor::text AS variance,
            (SELECT json_agg(json_build_object('description', l.description, 'total', l.total_minor::text) ORDER BY l.line_no)
               FROM sale_lines l WHERE l.sale_id = s.id) AS lines,
            (SELECT json_agg(json_build_object('method', p.method, 'provider', p.provider, 'amount', p.amount_minor::text))
               FROM payments p WHERE p.sale_id = s.id) AS payments
     FROM sales s WHERE s.id = $1`,
    [delivered.body?.sale_id],
  );
  check(
    'the sale carries the delivery fee as its own line, the online payment as its tender, and adds up',
    sale?.total === '2704' &&
      sale?.tax === '206' &&
      sale?.channel === 'delivery' &&
      sale?.variance === '0' &&
      sale?.lines?.length === 2 &&
      sale.lines[1].description === 'Delivery fee' &&
      sale.lines[1].total === '540' &&
      sale?.payments?.[0]?.method === 'card' &&
      sale.payments[0].provider === 'test' &&
      sale.payments[0].amount === '2704',
    JSON.stringify(sale),
  );

  const [capturedPayment] = await sql(
    `SELECT p.status::text, (p.captured_at IS NOT NULL) AS captured FROM order_payments p WHERE p.order_id = $1`,
    [orderId],
  );
  const [feeMoves] = await sql(
    `SELECT count(*)::int AS n FROM inventory_ledger l JOIN product_variants v ON v.id = l.variant_id WHERE v.sku = 'DELIVERY-FEE'`,
  );
  const [doorCheck] = await sql(
    `SELECT a.method::text, a.provider FROM age_verifications a WHERE a.sale_id = $1`,
    [delivered.body?.sale_id],
  );
  check(
    'the held payment is taken, one unit left the shelf, the fee moved no stock, and the ID check at the door is on record',
    capturedPayment?.status === 'captured' &&
      capturedPayment?.captured === true &&
      (await levelOf(pineapple.variantId)) === stockBefore - 1 &&
      feeMoves.n === 0 &&
      doorCheck?.method === 'provider' &&
      doorCheck?.provider === 'simulated',
    `${JSON.stringify(capturedPayment)} stock ${await levelOf(pineapple.variantId)} fee moves ${feeMoves.n} ${JSON.stringify(doorCheck)}`,
  );

  const deliveredAgain = await api(`/api/v1/orders/${orderId}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'delivered' } });
  const [salesForOrder] = await sql(`SELECT count(*)::int AS n FROM sales WHERE receipt_no = $1`, [orderNumber]);
  check('a repeated "delivered" report changes nothing and writes no second sale',
        deliveredAgain.body?.status === 'completed' && salesForOrder.n === 1, `${deliveredAgain.status} ${salesForOrder.n}`);

  const deliveredMail = await waitForMail((m) => m.text.includes(`${orderNumber} was delivered`));
  check('the customer is told it was delivered', deliveredMail.length === 1, `${deliveredMail.length} emails`);

  // A signed-in member's delivery earns points: $19.99 earns 19, the fee earns nothing.
  const caseyCart = (await shop('/cart', { method: 'POST', session: caseySession })).body?.cart_token;
  await shop(`/cart/lines/${pineapple.variantId}`, { cart: caseyCart, session: caseySession, method: 'POST', body: { quantity: 1 } });
  const caseyDelivery = await shop('/cart/fulfilment', {
    cart: caseyCart, session: caseySession, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76548' },
  });
  check('a signed-in member sees roughly what the order will earn', caseyDelivery.body?.points_to_earn === 19,
        JSON.stringify(caseyDelivery.body));
  const caseyOrder = await shop('/checkout', {
    cart: caseyCart,
    session: caseySession,
    method: 'POST',
    body: {
      age_attested: true,
      delivery: { address: { ...address, postal_code: '76548', city: 'Harker Heights' }, phone: '2545550123', date_of_birth: '1988-02-02' },
      payment_token: 'test-approve',
    },
  });
  const caseyQueued = (await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken })).body?.find(
    (entry) => entry.order_number === caseyOrder.body?.order_number,
  );
  for (const step of ['accept', 'ready', 'dispatch']) {
    await api(`/api/v1/orders/${caseyQueued?.id}/${step}`, { token: cashierToken, method: 'POST' });
  }
  await api(`/api/v1/orders/${caseyQueued?.id}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'delivered' } });
  const caseyTracked = await shop(`/orders/track/${caseyOrder.body?.tracking_token}`);
  check(
    'an online order earns points for the member, as a counter sale would, and says so',
    caseyTracked.body?.status === 'completed' && caseyTracked.body?.points_earned === 19 && (await loyaltyOf(caseyId))?.points === 39,
    `${JSON.stringify(caseyTracked.body?.points_earned)} ${(await loyaltyOf(caseyId))?.points}`,
  );

  // ----------------------------------------------------- 7. DoorDash's webhook

  const hook = (body, authorization = E2E_DOORDASH_AUTHORIZATION) =>
    api('/api/v1/webhooks/doordash', { method: 'POST', body, headers: authorization ? { authorization } : {} });

  const hookCart = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  await shop(`/cart/lines/${pineapple.variantId}`, { cart: hookCart, method: 'POST', body: { quantity: 1 } });
  await shop('/cart/fulfilment', { cart: hookCart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76548' } });
  const hookOrder = await shop('/checkout', {
    cart: hookCart,
    method: 'POST',
    body: { contact: { ...guest, email: 'hook@example.test' }, age_attested: true, delivery: adult, payment_token: 'test-approve' },
  });
  const hookQueued = (await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken })).body?.find(
    (entry) => entry.order_number === hookOrder.body?.order_number,
  );
  for (const step of ['accept', 'ready']) await api(`/api/v1/orders/${hookQueued?.id}/${step}`, { token: cashierToken, method: 'POST' });
  const hookDispatched = await api(`/api/v1/orders/${hookQueued?.id}/dispatch`, { token: cashierToken, method: 'POST' });
  const externalId = hookDispatched.body?.delivery?.external_delivery_id;

  const unsigned = await hook({ event_name: 'DASHER_PICKED_UP', external_delivery_id: externalId }, null);
  const forged = await hook({ event_name: 'DASHER_PICKED_UP', external_delivery_id: externalId }, 'Basic bm90OnRoZS1zZWNyZXQ=');
  check('a webhook without the agreed authorization is refused before it is read', unsigned.status === 401 && forged.status === 401,
        `${unsigned.status} ${forged.status}`);

  const unknown = await hook({ event_name: 'DASHER_PICKED_UP', external_delivery_id: 'snappos-not-a-delivery', created_at: new Date().toISOString() });
  check('a report on a delivery this system never booked is accepted and ignored', unknown.status === 200 && unknown.body?.status === 'ignored',
        JSON.stringify(unknown.body));

  const confirmedAt = new Date().toISOString();
  const confirmed = await hook({ event_name: 'DASHER_CONFIRMED', external_delivery_id: externalId, dasher_name: 'Alex Driver', created_at: confirmedAt, tracking_url: 'https://track.example/abc' });
  const afterConfirmed = await api(`/api/v1/orders/${hookQueued?.id}`, { token: cashierToken });
  check(
    "a driver accepting records who and where to follow it, without moving the order",
    confirmed.body?.status === 'processed' &&
      afterConfirmed.body?.status === 'courier_requested' &&
      afterConfirmed.body?.delivery?.driver_first_name === 'Alex' &&
      afterConfirmed.body?.delivery?.tracking_url === 'https://track.example/abc',
    `${JSON.stringify(confirmed.body)} ${JSON.stringify(afterConfirmed.body?.delivery)}`,
  );

  const pickedUpAt = new Date().toISOString();
  const viaHook = await hook({ event_name: 'DASHER_PICKED_UP', external_delivery_id: externalId, created_at: pickedUpAt });
  const resent = await hook({ event_name: 'DASHER_PICKED_UP', external_delivery_id: externalId, created_at: pickedUpAt });
  const afterPickup = await api(`/api/v1/orders/${hookQueued?.id}`, { token: cashierToken });
  check(
    'a pickup report moves the order on once, however many times DoorDash sends it',
    viaHook.body?.status === 'processed' &&
      resent.body?.status === 'duplicate' &&
      afterPickup.body?.status === 'in_transit' &&
      afterPickup.body?.events?.filter((e) => e.to_status === 'in_transit').length === 1,
    `${JSON.stringify(viaHook.body)} ${JSON.stringify(resent.body)} ${afterPickup.body?.status}`,
  );

  const droppedOff = await hook({ event_name: 'DASHER_DROPPED_OFF', external_delivery_id: externalId, created_at: new Date().toISOString() });
  const afterDropOff = await api(`/api/v1/orders/${hookQueued?.id}`, { token: cashierToken });
  check("DoorDash's drop-off report completes the order and writes its sale",
        droppedOff.body?.status === 'processed' && afterDropOff.body?.status === 'completed' && typeof afterDropOff.body?.sale_id === 'string',
        `${JSON.stringify(droppedOff.body)} ${afterDropOff.body?.status}`);

  // ------------------------------------------------ 8. when a delivery comes back

  const backCart = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  await shop(`/cart/lines/${pineapple.variantId}`, { cart: backCart, method: 'POST', body: { quantity: 1 } });
  await shop('/cart/fulfilment', { cart: backCart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76542' } });
  const backOrder = await shop('/checkout', {
    cart: backCart,
    method: 'POST',
    body: { contact: { ...guest, email: 'returned@example.test' }, age_attested: true, delivery: adult, payment_token: 'test-approve' },
  });
  const backQueued = (await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken })).body?.find(
    (entry) => entry.order_number === backOrder.body?.order_number,
  );
  for (const step of ['accept', 'ready', 'dispatch']) await api(`/api/v1/orders/${backQueued?.id}/${step}`, { token: cashierToken, method: 'POST' });
  const stockBeforeReturn = await levelOf(pineapple.variantId);
  await api(`/api/v1/orders/${backQueued?.id}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'picked_up' } });
  const returning = await api(`/api/v1/orders/${backQueued?.id}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'returning' } });
  const failedMail = await waitForMail((m) => m.text.includes(`couldn't deliver your order ${backOrder.body?.order_number}`));
  check(
    "when nobody 21 or older can take it, the delivery fails and the customer is told why",
    returning.body?.status === 'delivery_failed' && failedMail.length === 1 && failedMail[0].text.includes('valid ID'),
    `${returning.body?.status} ${failedMail.length}`,
  );

  const returned = await api(`/api/v1/orders/${backQueued?.id}/courier-reports`, { token: cashierToken, method: 'POST', body: { event: 'returned' } });
  const cancelledAfterReturn = await api(`/api/v1/orders/${backQueued?.id}/cancel`, {
    token: ownerToken, method: 'POST', body: { reason: 'Could not be delivered; customer asked to cancel.' },
  });
  const [released] = await sql(`SELECT status::text FROM order_payments WHERE order_id = $1`, [backQueued?.id]);
  check(
    'back at the shop it can be called off: the hold is released, no sale is written, and no stock moved',
    returned.body?.status === 'returned_to_store' &&
      cancelledAfterReturn.body?.status === 'cancelled' &&
      cancelledAfterReturn.body?.sale_id === null &&
      released?.status === 'voided' &&
      (await levelOf(pineapple.variantId)) === stockBeforeReturn,
    `${returned.body?.status} ${cancelledAfterReturn.status} ${JSON.stringify(released)}`,
  );

  const selfCancelCart = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  await shop(`/cart/lines/${pineapple.variantId}`, { cart: selfCancelCart, method: 'POST', body: { quantity: 1 } });
  await shop('/cart/fulfilment', { cart: selfCancelCart, method: 'PUT', body: { fulfilment: 'delivery', postal_code: '76542' } });
  const selfCancelOrder = await shop('/checkout', {
    cart: selfCancelCart,
    method: 'POST',
    body: { contact: { ...guest, email: 'selfcancel@example.test' }, age_attested: true, delivery: adult, payment_token: 'test-approve' },
  });
  const selfCancelled = await shop(`/orders/track/${selfCancelOrder.body?.tracking_token}/cancel`, { method: 'POST' });
  check('a customer who cancels before the shop starts gets the hold released',
        selfCancelled.body?.status === 'cancelled' && selfCancelled.body?.payment?.status === 'voided',
        JSON.stringify(selfCancelled.body?.payment));

  // ------------------------------------------------------------ 9. banners

  const [brands] = await sql(
    `SELECT (SELECT id FROM brands WHERE name = 'Lost Mary') AS lost_mary, (SELECT id FROM brands WHERE name = 'Zyn') AS zyn`,
  );
  // A PNG header is all the API reads: it takes a picture's size from it and stores the bytes as sent.
  const png = (width, height) => {
    const bytes = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const uploadBanner = async (token, fields, image = png(1920, 853), type = 'image/png') => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
    form.append('image', new Blob([image], { type }), 'banner.png');
    const response = await fetch(`${base}/api/v1/storefront/banners`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const hero = { placement: 'home_hero', title: 'Lost Mary BM6000', link_kind: 'brand', link_value: brands.lost_mary, alt_text: 'Lost Mary BM6000 disposable vapes', headline: 'Lost Mary BM6000' };

  const managerBanner = await uploadBanner(managerToken, hero);
  const notAPicture = await uploadBanner(ownerToken, hero, Buffer.from('this is not a picture'), 'image/png');
  const created = await uploadBanner(ownerToken, hero);
  check(
    'the owner adds a banner, a manager cannot, and a file that is not a picture is refused by its bytes',
    managerBanner.status === 403 && notAPicture.status === 400 && created.status === 201,
    `${managerBanner.status} ${notAPicture.status} ${created.status} ${JSON.stringify(created.body)}`,
  );

  const zynBanner = await uploadBanner(ownerToken, { ...hero, title: 'Zyn', link_value: brands.zyn, alt_text: 'Zyn nicotine pouches' });
  const staffList = await api(`/api/v1/storefront/banners?store_id=${storeId}`, { token: ownerToken });
  const shownHero = staffList.body?.find((b) => b.id === created.body?.id);
  const hiddenZyn = staffList.body?.find((b) => b.id === zynBanner.body?.id);
  check(
    'the back office sees which banners show, and why the others do not',
    shownHero?.visibility?.showing === true &&
      shownHero?.advertises_nicotine === true &&
      hiddenZyn?.visibility?.showing === false &&
      /nothing it links to is in stock/.test(hiddenZyn?.visibility?.reason ?? ''),
    JSON.stringify({ shownHero: shownHero?.visibility, hiddenZyn: hiddenZyn?.visibility }),
  );

  const shopHeroes = await shop('/banners?placement=home_hero');
  const onSite = shopHeroes.body?.find((b) => b.id === created.body?.id);
  const heroImage = await fetch(`${base}/api/v1/shop/banners/${created.body?.id}/media/image`, { headers: { 'x-shop-key': SHOP_KEY } });
  const zynImage = await fetch(`${base}/api/v1/shop/banners/${zynBanner.body?.id}/media/image`, { headers: { 'x-shop-key': SHOP_KEY } });
  check(
    'the website gets the showing banner with its size and warning flag, and cannot fetch a hidden one',
    onSite?.advertises_nicotine === true &&
      onSite?.image?.width === 1920 &&
      onSite?.link?.value === brands.lost_mary &&
      !shopHeroes.body?.some((b) => b.id === zynBanner.body?.id) &&
      heroImage.status === 200 &&
      heroImage.headers.get('content-type') === 'image/png' &&
      zynImage.status === 404,
    `${JSON.stringify(shopHeroes.body)} ${heroImage.status} ${zynImage.status}`,
  );

  const videoForm = new FormData();
  videoForm.append('video', new Blob([Buffer.alloc(1000, 7)], { type: 'video/mp4' }), 'clip.mp4');
  const withVideo = await fetch(`${base}/api/v1/storefront/banners/${created.body?.id}/video`, {
    method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: videoForm,
  });
  const ranged = await fetch(`${base}/api/v1/shop/banners/${created.body?.id}/media/video`, {
    headers: { 'x-shop-key': SHOP_KEY, range: 'bytes=0-99' },
  });
  check(
    'a banner video is served a range at a time, the way browsers ask for it',
    withVideo.status === 201 && ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 0-99/1000' &&
      (await ranged.arrayBuffer()).byteLength === 100,
    `${withVideo.status} ${ranged.status} ${ranged.headers.get('content-range')}`,
  );

  const switchedOff = await api(`/api/v1/storefront/banners/${created.body?.id}`, { token: ownerToken, method: 'PATCH', body: { status: 'inactive' } });
  const afterOff = await shop('/banners?placement=home_hero');
  check('a banner switched off leaves the website at once', switchedOff.status === 200 && !afterOff.body?.some((b) => b.id === created.body?.id),
        `${switchedOff.status} ${JSON.stringify(afterOff.body)}`);

  await direct.end();
}
