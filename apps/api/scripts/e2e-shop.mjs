#!/usr/bin/env node
/**
 * The website, end to end: a shopper browsing, filling a cart, checking out as
 * a guest and with an account, following an order, and the back office
 * controlling what the website may sell.
 *
 * Most of what matters here is refusal. A shop key that is missing, wrong or
 * revoked. An item that is not listed, out of stock, over its limit, or not
 * allowed by the rules. A second checkout from the same cart. A customer
 * session presented to a staff route. An account that has not confirmed its
 * email. And the answers that must not differ -- signing up with an address
 * that has an account and one that does not -- because the difference would
 * tell a stranger who shops here.
 *
 * Imported by e2e.mjs after the order checks, sharing their server and reset.
 * The orders section has already allowed pickup and listed Blue Razz Ice.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The development key the seed creates. */
const SHOP_KEY = 'shop_dev_only_not_a_secret';

export async function runShopChecks({ api, check, ownerToken, managerToken, cashierToken, storeId, mailbox }) {
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

  const variantFor = async (upc) => {
    const r = await api(`/api/v1/catalog/scan/${upc}?store_id=${storeId}`, { token: cashierToken });
    return { variantId: r.body?.variant_id, productId: r.body?.product_id };
  };
  const list = (variantId, settings) =>
    api(`/api/v1/storefront/listings/${variantId}`, { token: ownerToken, method: 'POST', body: settings });
  const levelOf = async (variantId) => {
    const r = await api(`/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`, { token: ownerToken });
    return Number(r.body?.[0]?.on_hand ?? NaN);
  };

  const mail = () =>
    readdirSync(mailbox).map((name) => ({ name, text: readFileSync(join(mailbox, name), 'utf8') }));
  const waitForMail = async (matches, ms = 10_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const found = mail().filter((m) => matches(m.text));
      if (found.length > 0) return found;
      await sleep(250);
    }
    return [];
  };
  const tokenIn = (text, path) => new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];

  // ---------------------------------------------------------------- 1. the key

  const noKey = await shop('/info', { key: null });
  check('the website API refuses a request without a shop key', noKey.status === 401, `${noKey.status}`);

  const wrongKey = await shop('/info', { key: 'shop_live_not_a_real_key_at_all_000000' });
  check('and a request with the wrong one', wrongKey.status === 401, `${wrongKey.status}`);

  const info = await shop('/info');
  check(
    'with the key, the website learns which shop it is and that email is in test mode',
    info.status === 200 && info.body?.shop_name === 'HH Smoke & Vape' && info.body?.test_mode === true,
    JSON.stringify(info.body),
  );

  const keyAsStaff = await api(`/api/v1/orders?store_id=${storeId}`, { headers: { 'x-shop-key': SHOP_KEY } });
  check('a shop key opens nothing in the back office', keyAsStaff.status === 401, `${keyAsStaff.status}`);

  // ------------------------------------------- 2. keys issued from the back office

  const managerKey = await api('/api/v1/storefront/clients', {
    token: managerToken,
    method: 'POST',
    body: { store_id: storeId, name: 'Should not exist' },
  });
  check('a manager cannot issue website keys', managerKey.status === 403, `${managerKey.status}`);

  const issued = await api('/api/v1/storefront/clients', {
    token: ownerToken,
    method: 'POST',
    body: { store_id: storeId, name: 'E2E website' },
  });
  const newKey = issued.body?.key;
  check(
    'the owner can issue a key, and sees it once',
    issued.status === 201 && typeof newKey === 'string' && newKey.startsWith('shop_live_'),
    JSON.stringify({ status: issued.status, prefix: issued.body?.client?.key_prefix }),
  );

  const listed = await api('/api/v1/storefront/clients', { token: ownerToken });
  check(
    'the key list shows how to recognise a key, never the key itself',
    listed.status === 200 && !JSON.stringify(listed.body).includes(newKey ?? '---'),
    `${listed.status}`,
  );

  check('a newly issued key works', (await shop('/info', { key: newKey })).status === 200);

  const revoked = await api(`/api/v1/storefront/clients/${issued.body?.client?.id}/revoke`, {
    token: ownerToken,
    method: 'POST',
  });
  check(
    'a revoked key stops working at once',
    revoked.status === 201 && (await shop('/info', { key: newKey })).status === 401,
    `${revoked.status}`,
  );

  // ------------------------------------------------------ 3. what is for sale

  const strawberry = await variantFor('840216300125'); // Geek Bar, 7 on hand
  const watermelon = await variantFor('840216300132'); // Geek Bar, none on hand
  const miami = await variantFor('840216300101'); // Geek Bar, never listed
  const raw = await variantFor('716165174233'); // rolling papers, no age limit
  const monster = await variantFor('070847811169'); // an energy drink
  const lostMary = await variantFor('810082310014'); // a vape nobody lists

  for (const item of [strawberry, watermelon, raw, monster]) {
    await list(item.variantId, { availability: 'pickup_only' });
  }

  const products = await shop('/products?page_size=48');
  const geekBar = products.body?.items?.find((card) => card.id === strawberry.productId);
  const papers = products.body?.items?.find((card) => card.id === raw.productId);
  check(
    'listed items appear, with their age limit on the card',
    products.status === 200 && geekBar?.minimum_age === 21 && papers?.minimum_age === null,
    JSON.stringify({ geekBar, papers }),
  );
  check(
    'an item nobody listed does not appear at all',
    !products.body?.items?.some((card) => card.id === lostMary.productId),
  );

  const detail = await shop(`/products/${strawberry.productId}`);
  const variantIds = detail.body?.variants?.map((v) => v.id) ?? [];
  check(
    'a product page offers only the flavours that are listed',
    detail.status === 200 && variantIds.includes(strawberry.variantId) && !variantIds.includes(miami.variantId),
    JSON.stringify(detail.body?.variants?.map((v) => v.name)),
  );
  check(
    'a flavour that is listed but has none left shows as out of stock, not missing',
    detail.body?.variants?.find((v) => v.id === watermelon.variantId)?.stock === 'out_of_stock',
    JSON.stringify(detail.body?.variants),
  );
  check(
    'stock is described, never counted',
    !JSON.stringify(detail.body).includes('"on_hand"') && !JSON.stringify(detail.body).includes('"sellable"'),
  );
  check('a product that is not listed has no page', (await shop(`/products/${lostMary.productId}`)).status === 404);

  const byUpc = await shop('/products?q=716165174233');
  check(
    'searching a UPC finds the item',
    byUpc.body?.items?.length === 1 && byUpc.body.items[0].id === raw.productId,
    JSON.stringify(byUpc.body?.items?.map((c) => c.name)),
  );

  const suggest = await shop('/suggest?q=geek');
  check(
    'search suggestions offer the product and the brand',
    suggest.body?.some((s) => s.kind === 'product') && suggest.body?.some((s) => s.kind === 'brand'),
    JSON.stringify(suggest.body),
  );

  const papersOnly = await shop('/products?category=accessories');
  check(
    'a category shows what is in it and beneath it, and nothing else',
    papersOnly.body?.items?.length === 1 && papersOnly.body.items[0].id === raw.productId,
    JSON.stringify(papersOnly.body?.items?.map((c) => c.name)),
  );

  // ------------------------------------------ 4. rules decide, from the back office

  const managerRule = await api('/api/v1/compliance/rules', {
    token: managerToken,
    method: 'POST',
    body: {
      name: 'Not allowed',
      effect: 'deny',
      channel: 'pickup',
      authority_note: 'A manager trying to change what may be sold.',
    },
  });
  check('a manager can read the rules but cannot change them', managerRule.status === 403, `${managerRule.status}`);

  const noDrinks = await api('/api/v1/compliance/rules', {
    token: ownerToken,
    method: 'POST',
    body: {
      name: 'E2E: no drinks online',
      effect: 'deny',
      channel: 'pickup',
      category_path: 'drinks',
      deny_message: 'Drinks are in store only.',
      authority_note: 'End to end check that a category can be taken off the website.',
    },
  });
  check('the owner can add a rule for the website', noDrinks.status === 201 && noDrinks.body?.live === true,
        `${noDrinks.status} ${JSON.stringify(noDrinks.body)}`);

  const withoutDrinks = await shop('/products?page_size=48');
  check(
    'a deny rule takes its category off the website straight away',
    !withoutDrinks.body?.items?.some((card) => card.id === monster.productId) &&
      withoutDrinks.body?.items?.some((card) => card.id === raw.productId),
  );

  const ended = await api(`/api/v1/compliance/rules/${noDrinks.body?.id}/end`, {
    token: ownerToken,
    method: 'POST',
    body: { reason: 'End to end check is over.' },
  });
  const withDrinks = await shop('/products?page_size=48');
  check(
    'ending the rule puts the category back, and the rule stays on record as ended',
    ended.status === 201 &&
      ended.body?.live === false &&
      withDrinks.body?.items?.some((card) => card.id === monster.productId),
    `${ended.status} ${JSON.stringify(ended.body)}`,
  );

  const rules = await api('/api/v1/compliance/rules', { token: managerToken });
  const platformRule = rules.body?.find((r) => r.platform);
  const endPlatform = await api(`/api/v1/compliance/rules/${platformRule?.id}/end`, {
    token: ownerToken,
    method: 'POST',
    body: { reason: 'Trying to end a platform rule.' },
  });
  check('a platform rule cannot be ended by a shop', endPlatform.status === 404, `${endPlatform.status}`);

  // ------------------------------------------------------------------ 5. a cart

  const created = await shop('/cart', { method: 'POST' });
  const cart = created.body?.cart_token;
  check('a cart is created empty', created.status === 201 && created.body?.cart?.item_count === 0,
        JSON.stringify(created.body));

  const two = await shop(`/cart/lines/${strawberry.variantId}`, { cart, method: 'POST', body: { quantity: 2 } });
  check(
    'adding an item prices the cart, with the tax the counter will charge',
    two.status === 200 &&
      two.body?.subtotal_minor === '4998' &&
      two.body?.estimated_tax_minor === '412' &&
      two.body?.estimated_total_minor === '5410' &&
      two.body?.can_checkout === true,
    JSON.stringify(two.body),
  );
  check('the cart knows it holds a 21+ item', two.body?.minimum_age === 21 && two.body?.id_required === true);

  const none = await shop(`/cart/lines/${watermelon.variantId}`, { cart, method: 'POST', body: { quantity: 1 } });
  check('an out of stock item cannot be added', none.status === 409 && /out of stock/i.test(none.body?.message ?? ''),
        `${none.status} ${JSON.stringify(none.body)}`);

  const tooMany = await shop(`/cart/lines/${strawberry.variantId}`, { cart, method: 'PUT', body: { quantity: 8 } });
  check('more than is left is refused, saying how many are', tooMany.status === 409 && /only 7 left/i.test(tooMany.body?.message ?? ''),
        `${tooMany.status} ${JSON.stringify(tooMany.body)}`);

  const unlisted = await shop(`/cart/lines/${miami.variantId}`, { cart, method: 'POST', body: { quantity: 1 } });
  check('an unlisted item cannot be added', unlisted.status === 409, `${unlisted.status}`);

  await list(raw.variantId, { availability: 'pickup_only', max_per_order: '2' });
  const overLimit = await shop(`/cart/lines/${raw.variantId}`, { cart, method: 'PUT', body: { quantity: 3 } });
  check('a per-order limit is enforced', overLimit.status === 409 && /limit 2/i.test(overLimit.body?.message ?? ''),
        `${overLimit.status} ${JSON.stringify(overLimit.body)}`);
  await list(raw.variantId, { clear_max_per_order: true });
  const cleared = await shop(`/cart/lines/${raw.variantId}`, { cart, method: 'PUT', body: { quantity: 3 } });
  const removed = await shop(`/cart/lines/${raw.variantId}`, { cart, method: 'PUT', body: { quantity: 0 } });
  check(
    'a limit can be taken off again, and a quantity of zero removes the line',
    cleared.status === 200 && removed.status === 200 && removed.body?.lines?.length === 1,
    `${cleared.status} ${removed.status} ${JSON.stringify(removed.body?.lines?.map((l) => l.product_name))}`,
  );

  check('a made-up cart token finds no cart', (await shop('/cart', { cart: 'x'.repeat(43) })).status === 404);

  // --------------------------------------------------------- 6. guest checkout

  const stockBefore = await levelOf(strawberry.variantId);

  const noContact = await shop('/checkout', { cart, method: 'POST', body: { age_attested: true } });
  check('a guest has to say who is collecting', noContact.status === 400, `${noContact.status}`);

  const guest = { first_name: 'Jordan', last_name: 'Ellis', email: 'jordan@example.test' };
  const noAge = await shop('/checkout', { cart, method: 'POST', body: { contact: guest } });
  check('checkout needs the customer to say they are old enough', noAge.status === 400, `${noAge.status}`);

  const placed = await shop('/checkout', {
    cart,
    method: 'POST',
    body: { contact: guest, age_attested: true, note: 'Picking up after work.' },
  });
  const trackingToken = placed.body?.tracking_token;
  check(
    'a guest can check out',
    placed.status === 201 && typeof placed.body?.order_number === 'string' && typeof trackingToken === 'string',
    `${placed.status} ${JSON.stringify(placed.body)}`,
  );

  const twice = await shop('/checkout', { cart, method: 'POST', body: { contact: guest, age_attested: true } });
  check(
    'submitting the same cart again returns the same order rather than a second one',
    twice.body?.order_number === placed.body?.order_number && twice.body?.tracking_token === trackingToken,
    `${twice.status} ${JSON.stringify(twice.body)}`,
  );
  check('checking out claims stock, it does not move it', (await levelOf(strawberry.variantId)) === stockBefore);

  // ------------------------------------------------------ 7. following the order

  const tracked = await shop(`/orders/track/${trackingToken}`);
  check(
    'the tracking link shows the order the way the customer should see it',
    tracked.status === 200 &&
      tracked.body?.status_label === 'Received' &&
      tracked.body?.first_name === 'Jordan' &&
      tracked.body?.total_minor === '5410' &&
      tracked.body?.can_cancel === true &&
      tracked.body?.minimum_age === 21,
    JSON.stringify(tracked.body),
  );
  check(
    'and shows nothing a forwarded link should not: no surname, no email address',
    !JSON.stringify(tracked.body).includes('Ellis') && !JSON.stringify(tracked.body).includes('jordan@example.test'),
  );

  const [idPart, macPart] = (trackingToken ?? '.').split('.');
  const forged = `${idPart.slice(0, -1)}${idPart.endsWith('A') ? 'B' : 'A'}.${macPart}`;
  check('an altered tracking link opens nothing', (await shop(`/orders/track/${forged}`)).status === 404);

  const confirmation = await waitForMail((text) => text.includes(`We got your order ${placed.body?.order_number}`));
  check(
    'the customer is emailed a confirmation with their tracking link and the ID reminder',
    confirmation.length === 1 &&
      confirmation[0].text.includes(`http://shop.e2e.test/track/${trackingToken}`) &&
      confirmation[0].text.includes('photo ID'),
    `${confirmation.length} confirmation emails`,
  );

  const staffView = await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken });
  const queued = staffView.body?.find((entry) => entry.order_number === placed.body?.order_number);
  check('the website order reaches the counter queue', queued?.minimum_age === 21, JSON.stringify(queued));

  await api(`/api/v1/orders/${queued?.id}/accept`, { token: cashierToken, method: 'POST' });
  const tooLate = await shop(`/orders/track/${trackingToken}/cancel`, { method: 'POST' });
  check(
    'once the shop has accepted it, the customer is told to call instead of cancelling',
    tooLate.status === 409 && /call the shop/i.test(tooLate.body?.message ?? ''),
    `${tooLate.status} ${JSON.stringify(tooLate.body)}`,
  );

  await api(`/api/v1/orders/${queued?.id}/ready`, { token: cashierToken, method: 'POST' });
  const readyMail = await waitForMail((text) => text.includes(`${placed.body?.order_number} is ready to pick up`));
  check('the customer is emailed when it is ready', readyMail.length === 1, `${readyMail.length} ready emails`);

  // A second guest order, called off by the customer before the shop took it.
  const cart2 = (await shop('/cart', { method: 'POST' })).body?.cart_token;
  await shop(`/cart/lines/${raw.variantId}`, { cart: cart2, method: 'POST', body: { quantity: 1 } });
  const second = await shop('/checkout', { cart: cart2, method: 'POST', body: { contact: guest, age_attested: true } });
  const cancelled = await shop(`/orders/track/${second.body?.tracking_token}/cancel`, { method: 'POST' });
  check(
    'before the shop accepts it, the customer can cancel it themselves',
    cancelled.status === 200 && cancelled.body?.status === 'cancelled' && cancelled.body?.can_cancel === false,
    `${cancelled.status} ${JSON.stringify(cancelled.body)}`,
  );
  check('and no papers were claimed by an order that no longer exists',
        !(await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken })).body?.some(
          (entry) => entry.order_number === second.body?.order_number));

  // --------------------------------------------------------------- 8. accounts

  const riley = { first_name: 'Riley', last_name: 'Nguyen', email: 'riley@example.test', password: 'correct horse battery' };

  const weak = await shop('/account/register', {
    method: 'POST',
    body: { ...riley, password: 'short', age_attested: true },
  });
  check('a short password is refused', weak.status === 400, `${weak.status}`);

  const registered = await shop('/account/register', {
    method: 'POST',
    body: { ...riley, marketing_email: true, age_attested: true },
  });
  const again = await shop('/account/register', {
    method: 'POST',
    body: { ...riley, marketing_email: false, age_attested: true },
  });
  check(
    'signing up answers identically whether or not the address already has an account',
    registered.status === 202 &&
      again.status === 202 &&
      JSON.stringify(registered.body) === JSON.stringify(again.body),
    `${JSON.stringify(registered.body)} / ${JSON.stringify(again.body)}`,
  );

  const early = await shop('/account/sign-in', { method: 'POST', body: { email: riley.email, password: riley.password } });
  check(
    'nobody signs in before confirming their email address',
    early.status === 403 && /confirm your email/i.test(early.body?.message ?? ''),
    `${early.status} ${JSON.stringify(early.body)}`,
  );

  const verifyMail = await waitForMail((text) => text.includes('To: riley@example.test') && text.includes('/account/verify?token='));
  const verifyToken = tokenIn(verifyMail[0]?.text ?? '', '/account/verify');
  const verified = await shop('/account/verify-email', { method: 'POST', body: { token: verifyToken } });
  const session = verified.body?.session_token;
  check(
    'following the confirmation link signs the customer in, and records the marketing opt-in only then',
    verified.status === 200 && typeof session === 'string' && verified.body?.customer?.marketing_email === true,
    `${verified.status} ${JSON.stringify(verified.body?.customer)}`,
  );
  check(
    'a confirmation link works once',
    (await shop('/account/verify-email', { method: 'POST', body: { token: verifyToken } })).status === 400,
  );

  const wrongPassword = await shop('/account/sign-in', { method: 'POST', body: { email: riley.email, password: 'not the password' } });
  const noAccount = await shop('/account/sign-in', { method: 'POST', body: { email: 'nobody@example.test', password: 'not the password' } });
  check(
    'a wrong password and an unknown address get the same answer',
    wrongPassword.status === 401 &&
      noAccount.status === 401 &&
      wrongPassword.body?.message === noAccount.body?.message,
    `${wrongPassword.body?.message} / ${noAccount.body?.message}`,
  );

  const asStaff = await api('/api/v1/registers', { token: session });
  check('a customer session opens nothing in the back office', asStaff.status === 401, `${asStaff.status}`);

  const me = await shop('/account/me', { session });
  check('a signed-in customer can see their profile', me.status === 200 && me.body?.email === riley.email,
        JSON.stringify(me.body));

  // Checking out signed in: no contact form, the account's own details.
  const cart3 = (await shop('/cart', { method: 'POST', session })).body?.cart_token;
  await shop(`/cart/lines/${raw.variantId}`, { cart: cart3, session, method: 'POST', body: { quantity: 2 } });
  const own = await shop('/checkout', { cart: cart3, session, method: 'POST', body: { age_attested: true } });
  const history = await shop('/account/me/orders', { session });
  check(
    "a signed-in customer's order is theirs, and shows in their order history",
    own.status === 201 && history.body?.some((o) => o.order_number === own.body?.order_number && o.tracking_token === own.body?.tracking_token),
    `${own.status} ${JSON.stringify(history.body)}`,
  );

  const optedOut = await shop('/account/me/consents', { session, method: 'PUT', body: { marketing_email: false } });
  check('a customer can withdraw marketing consent themselves', optedOut.status === 200 && optedOut.body?.marketing_email === false,
        JSON.stringify(optedOut.body));

  const forgotUnknown = await shop('/account/forgot-password', { method: 'POST', body: { email: 'nobody@example.test' } });
  const forgotKnown = await shop('/account/forgot-password', { method: 'POST', body: { email: riley.email } });
  check(
    'asking for a reset answers the same whether or not an account exists',
    forgotUnknown.status === 202 && forgotKnown.status === 202 &&
      JSON.stringify(forgotUnknown.body) === JSON.stringify(forgotKnown.body),
  );

  const resetMail = await waitForMail((text) => text.includes('To: riley@example.test') && text.includes('/account/reset-password?token='));
  const resetToken = tokenIn(resetMail[0]?.text ?? '', '/account/reset-password');
  const reset = await shop('/account/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: 'a different long passphrase' },
  });
  check('a reset link sets a new password and signs the customer in', reset.status === 200 && typeof reset.body?.session_token === 'string',
        `${reset.status}`);
  check('and ends every session that existed before it', (await shop('/account/me', { session })).status === 401);

  const oldPassword = await shop('/account/sign-in', { method: 'POST', body: { email: riley.email, password: riley.password } });
  const newPassword = await shop('/account/sign-in', { method: 'POST', body: { email: riley.email, password: 'a different long passphrase' } });
  check('the old password stops working and the new one works', oldPassword.status === 401 && newPassword.status === 200,
        `${oldPassword.status} ${newPassword.status}`);

  const signedOut = await shop('/account/sign-out', { session: newPassword.body?.session_token, method: 'POST' });
  check(
    'signing out ends the session',
    signedOut.status === 200 && (await shop('/account/me', { session: newPassword.body?.session_token })).status === 401,
  );

  check(
    'no email the website sent contains a password',
    !mail().some((m) => m.text.includes(riley.password) || m.text.includes('a different long passphrase')),
  );
}
