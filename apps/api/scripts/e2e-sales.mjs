#!/usr/bin/env node
/**
 * A day at the counter, end to end.
 *
 * Opens a drawer, rings a sale through the sync path exactly as an offline
 * register would, replays it the way a flaky network does, refunds part of it,
 * tries to refund more than was sold, voids a second sale, and closes the
 * drawer on a blind count.
 *
 * Imported by e2e.mjs after its own checks, so both share one server and one
 * reset. Exported rather than standalone because starting a second server and
 * resetting the database twice doubles the runtime for no extra coverage.
 */

import { randomUUID } from 'node:crypto';

export async function runSalesChecks({ api, check, uuidV7, ownerToken, managerToken, cashierToken, storeId }) {
  // ------------------------------------------------------------------ context

  const registers = await api('/api/v1/registers', { token: ownerToken });
  const registerId = registers.body?.data?.[0]?.id;

  const session = await api('/api/v1/auth/session', { token: cashierToken });
  const cashierId = session.body?.user_id;
  check('the session endpoint identifies the caller', typeof cashierId === 'string',
        JSON.stringify(session));

  const ownerSession = await api('/api/v1/auth/session', { token: ownerToken });
  const ownerId = ownerSession.body?.user_id;

  const scan = await api(`/api/v1/catalog/scan/840216300101?store_id=${storeId}`, {
    token: cashierToken,
  });
  const variantId = scan.body?.variant_id;

  const levelOf = async (id = variantId) => {
    const r = await api(`/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${id}`, {
      token: ownerToken,
    });
    return Number(r.body?.[0]?.on_hand ?? NaN);
  };

  // --------------------------------------------------------- 1. open a drawer

  const open = await api('/api/v1/cash/sessions', {
    token: managerToken,
    method: 'POST',
    body: { register_id: registerId, opening_float_minor: '20000', blind: true },
  });
  check('a cash session opens', open.status === 201, JSON.stringify(open.body));
  const sessionId = open.body?.id;

  const second = await api('/api/v1/cash/sessions', {
    token: managerToken,
    method: 'POST',
    body: { register_id: registerId, opening_float_minor: '20000' },
  });
  check(
    'a register cannot have two open drawers',
    second.status === 409,
    `got ${second.status}`,
  );

  const blindStatus = await api(`/api/v1/cash/sessions/${sessionId}`, { token: managerToken });
  check(
    'a blind session hides expected cash while it is open',
    blindStatus.body?.expected_minor === null && blindStatus.body?.blind_pending === true,
    JSON.stringify(blindStatus.body),
  );

  // ------------------------------------------------------------- 2. ring a sale

  const stockBefore = await levelOf();

  const saleId = uuidV7();
  const lineId = uuidV7();
  const paymentId = uuidV7();
  const completedAt = new Date().toISOString();

  // Two Geek Bars at 24.99 = 49.98, tax 8.25% = 4.12, total 54.10.
  const saleEnvelope = {
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id: saleId,
        entity_type: 'sale',
        device_time: completedAt,
        payload: {
          store_id: storeId,
          register_id: registerId,
          session_id: sessionId,
          cashier_user_id: cashierId,
          receipt_no: `HH01-R1-${Date.now() % 100000}`,
          register_sequence: 1,
          status: 'completed',
          subtotal_minor: '4998',
          tax_minor: '412',
          total_minor: '5410',
          device_time: completedAt,
          completed_at: completedAt,
          lines: [
            {
              id: lineId,
              line_no: 1,
              variant_id: variantId,
              description: 'Geek Bar Pulse X - Miami Mint',
              sku_snapshot: 'GB-PULSEX-MM',
              barcode_scanned: '840216300101',
              quantity: '2',
              unit_price_minor: '2499',
              original_price_minor: '2499',
              tax_minor: '412',
              total_minor: '5410',
              unit_cost: '9.850000',
              compliance_snapshot: { minimum_age: 21, id_scan_required: true },
            },
          ],
          payments: [
            {
              id: paymentId,
              method: 'cash',
              amount_minor: '5410',
              tendered_minor: '6000',
              change_minor: '590',
              device_time: completedAt,
            },
          ],
          age_verifications: [
            {
              id: uuidV7(),
              sale_line_id: lineId,
              method: 'scan',
              result: 'pass',
              minimum_age_applied: 21,
              verified_at: completedAt,
            },
          ],
        },
      },
    ],
  };

  const rung = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: saleEnvelope,
  });
  check(
    'an offline sale uploads and is accepted',
    rung.body?.results?.[0]?.status === 'accepted',
    JSON.stringify(rung.body),
  );

  const afterSale = await levelOf();
  check(
    'the sale deducted stock',
    afterSale === stockBefore - 2,
    `expected ${stockBefore - 2}, got ${afterSale}`,
  );

  // ----------------------------------------------- 3. the network is unreliable

  const replay1 = await api('/api/v1/sync/batch', { token: cashierToken, method: 'POST', body: saleEnvelope });
  const replay2 = await api('/api/v1/sync/batch', { token: cashierToken, method: 'POST', body: saleEnvelope });
  check(
    'the same sale delivered three times is one sale',
    replay1.body?.results?.[0]?.status === 'duplicate' &&
      replay2.body?.results?.[0]?.status === 'duplicate',
    JSON.stringify([replay1.body?.results?.[0], replay2.body?.results?.[0]]),
  );

  const afterReplays = await levelOf();
  check(
    'three deliveries moved stock exactly once',
    afterReplays === stockBefore - 2,
    `expected ${stockBefore - 2}, got ${afterReplays}`,
  );

  const fetched = await api(`/api/v1/sales/${saleId}`, { token: cashierToken });
  check(
    'the sale reads back with its line and its tender',
    fetched.body?.lines?.length === 1 && fetched.body?.payments?.length === 1,
    JSON.stringify(fetched.body?.lines?.length),
  );
  check(
    'the age check was recorded as metadata, with no identity fields',
    !JSON.stringify(fetched.body).match(/date_of_birth|licence|license_number|id_image/i),
  );

  // ------------------------------------------------------- 4. the drawer moved

  const drawer = await api(`/api/v1/cash/sessions/${sessionId}`, { token: managerToken });
  const saleKind = drawer.body?.breakdown?.find((b) => b.kind === 'sale');
  check(
    'the cash tender reached the drawer at the amount, not the tender',
    saleKind?.total === '5410',
    `drawer sale total ${saleKind?.total} (should be 5410, not 6000)`,
  );

  const paidOut = await api('/api/v1/cash/movements', {
    token: managerToken,
    method: 'POST',
    body: { session_id: sessionId, kind: 'paid_out', amount_minor: '-2500', reason: 'window cleaner' },
  });
  check('a paid out is recorded', paidOut.status === 201, JSON.stringify(paidOut.body));

  const noReason = await api('/api/v1/cash/movements', {
    token: managerToken,
    method: 'POST',
    body: { session_id: sessionId, kind: 'paid_out', amount_minor: '-500' },
  });
  check('a paid out with no reason is refused', noReason.status === 400,
        `got ${noReason.status} ${JSON.stringify(noReason.body)}`);

  // ---------------------------------------------------------------- 5. refunds

  // A cashier cannot look up or issue a refund: refund.create is a manager
  // permission by default, which is the correct policy for a shop like this.
  const cashierPeek = await api(`/api/v1/refunds/for-sale/${saleId}`, { token: cashierToken });
  check(
    'a cashier cannot start a refund',
    cashierPeek.status === 403,
    `got ${cashierPeek.status}`,
  );

  const refundable = await api(`/api/v1/refunds/for-sale/${saleId}`, { token: managerToken });
  check(
    'the register can see what is still refundable',
    refundable.body?.lines?.[0]?.refundable === '2.000',
    JSON.stringify(refundable.body),
  );

  const refundId = uuidV7();
  const refundLineId = uuidV7();
  const refundEnvelope = (id, lineIdArg, qty) => ({
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id,
        entity_type: 'refund',
        device_time: new Date().toISOString(),
        payload: {
          store_id: storeId,
          register_id: registerId,
          session_id: sessionId,
          original_sale_id: saleId,
          cashier_user_id: cashierId,
          approved_by: ownerId,
          receipt_no: `HH01-R1-R${Date.now() % 100000}`,
          reason_code: 'customer_changed_mind',
          subtotal_minor: String(2499 * qty),
          tax_minor: String(206 * qty),
          total_minor: String(2705 * qty),
          device_time: new Date().toISOString(),
          lines: [
            {
              id: lineIdArg,
              sale_line_id: lineId,
              variant_id: variantId,
              description: 'Geek Bar Pulse X - Miami Mint',
              quantity: String(qty),
              unit_price_minor: '2499',
              tax_minor: String(206 * qty),
              total_minor: String(2705 * qty),
              unit_cost: '9.850000',
              restocked: true,
            },
          ],
          payments: [
            {
              id: uuidV7(),
              method: 'cash',
              amount_minor: String(2705 * qty),
              device_time: new Date().toISOString(),
            },
          ],
        },
      },
    ],
  });

  // The permission that guards /refunds must guard the sync route too, or a
  // cashier could issue a refund by putting it in a batch instead.
  const smuggled = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: refundEnvelope(uuidV7(), uuidV7(), 1),
  });
  check(
    'a cashier cannot smuggle a refund through the sync endpoint',
    smuggled.body?.results?.[0]?.status === 'rejected' &&
      smuggled.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(smuggled.body?.results?.[0]),
  );

  const partial = await api('/api/v1/sync/batch', {
    token: managerToken,
    method: 'POST',
    body: refundEnvelope(refundId, refundLineId, 1),
  });
  check(
    'one of two can be refunded',
    partial.body?.results?.[0]?.status === 'accepted',
    JSON.stringify(partial.body),
  );

  const afterRefund = await levelOf();
  check(
    'a restocked refund put the unit back',
    afterRefund === stockBefore - 1,
    `expected ${stockBefore - 1}, got ${afterRefund}`,
  );

  const replayRefund = await api('/api/v1/sync/batch', {
    token: managerToken,
    method: 'POST',
    body: refundEnvelope(refundId, refundLineId, 1),
  });
  check(
    'a replayed refund is a duplicate, not a second refund',
    replayRefund.body?.results?.[0]?.status === 'duplicate',
  );
  check(
    'the replayed refund did not restock twice',
    (await levelOf()) === stockBefore - 1,
  );

  // The critical one: three were never sold, so three can never come back.
  const overRefund = await api('/api/v1/sync/batch', {
    token: managerToken,
    method: 'POST',
    body: refundEnvelope(uuidV7(), uuidV7(), 2),
  });
  check(
    'refunding more than was sold is refused',
    overRefund.body?.results?.[0]?.status === 'rejected',
    JSON.stringify(overRefund.body?.results?.[0]),
  );
  check(
    'the refused refund changed no stock',
    (await levelOf()) === stockBefore - 1,
  );

  const remaining = await api(`/api/v1/refunds/for-sale/${saleId}`, { token: managerToken });
  check(
    'one unit remains refundable',
    remaining.body?.lines?.[0]?.refundable === '1.000',
    JSON.stringify(remaining.body?.lines?.[0]?.refundable),
  );

  // ------------------------------------------------------------------ 6. voids

  const voidSaleId = uuidV7();
  const voidLineId = uuidV7();
  const voidAt = new Date().toISOString();
  const voidable = {
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id: voidSaleId,
        entity_type: 'sale',
        device_time: voidAt,
        payload: {
          store_id: storeId,
          register_id: registerId,
          session_id: sessionId,
          cashier_user_id: cashierId,
          receipt_no: `HH01-R1-V${Date.now() % 100000}`,
          register_sequence: 2,
          status: 'completed',
          subtotal_minor: '2499',
          tax_minor: '206',
          total_minor: '2705',
          device_time: voidAt,
          completed_at: voidAt,
          lines: [
            {
              id: voidLineId,
              line_no: 1,
              variant_id: variantId,
              description: 'Geek Bar Pulse X - Miami Mint',
              sku_snapshot: 'GB-PULSEX-MM',
              quantity: '1',
              unit_price_minor: '2499',
              original_price_minor: '2499',
              tax_minor: '206',
              total_minor: '2705',
              unit_cost: '9.850000',
            },
          ],
          payments: [
            { id: uuidV7(), method: 'cash', amount_minor: '2705', device_time: voidAt },
          ],
        },
      },
    ],
  };

  await api('/api/v1/sync/batch', { token: cashierToken, method: 'POST', body: voidable });
  const beforeVoid = await levelOf();

  const cashierVoid = await api(`/api/v1/sales/${voidSaleId}/void`, {
    token: cashierToken,
    method: 'POST',
    body: { reason: 'mistake' },
  });
  check('a cashier cannot void a sale', cashierVoid.status === 403, `got ${cashierVoid.status}`);

  const voided = await api(`/api/v1/sales/${voidSaleId}/void`, {
    token: managerToken,
    method: 'POST',
    body: { reason: 'rang the wrong item' },
  });
  check('a manager can void a sale', voided.status === 201, JSON.stringify(voided.body));

  check(
    'voiding returned the stock',
    (await levelOf()) === beforeVoid + 1,
    `expected ${beforeVoid + 1}, got ${await levelOf()}`,
  );

  const twice = await api(`/api/v1/sales/${voidSaleId}/void`, {
    token: managerToken,
    method: 'POST',
    body: { reason: 'again' },
  });
  check('a sale cannot be voided twice', twice.status === 409);

  const alreadyRefunded = await api(`/api/v1/sales/${saleId}/void`, {
    token: managerToken,
    method: 'POST',
    body: { reason: 'trying to void a partly refunded sale' },
  });
  check(
    'a partly refunded sale cannot be voided (that would double count the return)',
    alreadyRefunded.status === 409,
    `got ${alreadyRefunded.status}`,
  );

  // --------------------------------------------------------- 7. close the drawer

  const reconcile = await api(`/api/v1/inventory/reconcile?store_id=${storeId}`, {
    token: ownerToken,
  });
  check(
    'after a full day the ledger and the levels still agree',
    reconcile.body?.healthy === true,
    JSON.stringify(reconcile.body?.drift),
  );

  const closed = await api(`/api/v1/cash/sessions/${sessionId}/close`, {
    token: managerToken,
    method: 'POST',
    body: { counted_minor: '20000' },
  });
  check('the drawer closes', closed.status === 201, JSON.stringify(closed.body));

  // 20000 float + 5410 sale + 2705 sale - 2500 paid out - 2705 refund = 22910.
  check(
    'expected cash is the sum of every movement',
    closed.body?.expected_minor === '22910',
    `expected_minor was ${closed.body?.expected_minor}`,
  );
  check(
    'counting 20000 against 22910 reports short, by the difference',
    closed.body?.outcome === 'short' && closed.body?.variance_minor === '-2910',
    JSON.stringify(closed.body),
  );

  const closeAgain = await api(`/api/v1/cash/sessions/${sessionId}/close`, {
    token: managerToken,
    method: 'POST',
    body: { counted_minor: '22910' },
  });
  check('a closed drawer cannot be closed again', closeAgain.status === 409);

  const lateMovement = await api('/api/v1/cash/movements', {
    token: managerToken,
    method: 'POST',
    body: { session_id: sessionId, kind: 'paid_in', amount_minor: '2910', reason: 'found it' },
  });
  check(
    'a closed session takes no new movements',
    lateMovement.status === 409,
    `got ${lateMovement.status}`,
  );

  // ------------------------------------------------------------- 8. audit trail

  const audit = await api(`/api/v1/audit?entity_id=${voidSaleId}`, { token: ownerToken });
  check(
    'the void left an audit entry naming who did it and why',
    audit.body?.data?.some(
      (e) => e.action === 'sale.void' && e.reason === 'rang the wrong item',
    ),
    JSON.stringify(audit.body?.data),
  );

  const cashAudit = await api(`/api/v1/audit?entity_id=${sessionId}`, { token: ownerToken });
  check(
    'opening and closing the drawer are both audited',
    cashAudit.body?.data?.some((e) => e.action === 'cash.session_open') &&
      cashAudit.body?.data?.some((e) => e.action === 'cash.session_close'),
    JSON.stringify(cashAudit.body?.data?.map((e) => e.action)),
  );
}
