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
import pg from 'pg';

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
  const refundEnvelope = (id, lineIdArg, qty, approver = ownerId) => ({
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
          ...(approver ? { approved_by: approver } : {}),
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

  // A register uploads under the cashier's token, so the sync route cannot
  // simply trust it - but it cannot simply refuse it either, or a refund a
  // manager approved offline could never be delivered. Authority comes from
  // the user the payload names, and these are the two ways that can fail.
  const unapproved = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: refundEnvelope(uuidV7(), uuidV7(), 1, null),
  });
  check(
    'a cashier cannot smuggle an unapproved refund through the sync endpoint',
    unapproved.body?.results?.[0]?.status === 'rejected' &&
      unapproved.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(unapproved.body?.results?.[0]),
  );

  // The device's claim about who approved is checked, not believed. Naming
  // yourself is the obvious attack and it has to fail.
  const selfApproved = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: refundEnvelope(uuidV7(), uuidV7(), 1, cashierId),
  });
  check(
    'a cashier cannot approve their own refund by naming themselves',
    selfApproved.body?.results?.[0]?.status === 'rejected' &&
      selfApproved.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(selfApproved.body?.results?.[0]),
  );

  const partial = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: refundEnvelope(refundId, refundLineId, 1),
  });
  check(
    'a refund a manager approved uploads under the cashier token that carried it',
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

  // ------------------------------------- a void taken at the counter, offline
  //
  // The register uploads under the cashier's token and a cashier cannot void.
  // Authority comes from the manager the payload names, exactly as it does for
  // a refund, or a void approved during an outage could never be delivered.

  const offlineVoidSaleId = uuidV7();
  const offlineVoidLineId = uuidV7();
  const offlineSale = {
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id: offlineVoidSaleId,
        entity_type: 'sale',
        device_time: new Date().toISOString(),
        payload: {
          store_id: storeId,
          register_id: registerId,
          session_id: sessionId,
          cashier_user_id: cashierId,
          receipt_no: `HH01-R1-OV${Date.now() % 100000}`,
          register_sequence: 3,
          status: 'completed',
          subtotal_minor: '2499',
          tax_minor: '206',
          total_minor: '2705',
          device_time: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          lines: [
            {
              id: offlineVoidLineId,
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
            {
              id: uuidV7(),
              method: 'cash',
              amount_minor: '2705',
              device_time: new Date().toISOString(),
            },
          ],
        },
      },
    ],
  };
  const offlineSaleUpload = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: offlineSale,
  });
  // Asserted rather than assumed. A setup step that fails silently surfaces
  // later as an unrelated assertion failing for a reason it does not name.
  check(
    'the sale to be voided uploaded',
    offlineSaleUpload.body?.results?.[0]?.status === 'accepted',
    JSON.stringify(offlineSaleUpload.body?.results?.[0]),
  );
  const beforeOfflineVoid = await levelOf();

  const voidEnvelope = (id, approver) => ({
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id,
        entity_type: 'sale_void',
        device_time: new Date().toISOString(),
        payload: {
          sale_id: offlineVoidSaleId,
          cashier_user_id: cashierId,
          ...(approver ? { approved_by: approver } : {}),
          reason: 'rang the wrong item',
          device_time: new Date().toISOString(),
        },
      },
    ],
  });

  const unapprovedVoid = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: voidEnvelope(uuidV7(), null),
  });
  check(
    'a cashier cannot smuggle an unapproved void through the sync endpoint',
    unapprovedVoid.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(unapprovedVoid.body?.results?.[0]),
  );

  const selfApprovedVoid = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: voidEnvelope(uuidV7(), cashierId),
  });
  check(
    'a cashier cannot approve their own void by naming themselves',
    selfApprovedVoid.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(selfApprovedVoid.body?.results?.[0]),
  );

  check(
    'neither refused void changed any stock',
    (await levelOf()) === beforeOfflineVoid,
    `expected ${beforeOfflineVoid}, got ${await levelOf()}`,
  );

  const drawerBeforeVoid = await (async () => {
    const status = await api(`/api/v1/cash/sessions/${sessionId}`, { token: managerToken });
    const row = (status.body?.breakdown ?? []).find((b) => b.kind === 'refund');
    return BigInt(row?.total ?? '0');
  })();

  const voidId = uuidV7();
  const approvedVoid = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: voidEnvelope(voidId, ownerId),
  });
  check(
    'a void a manager approved uploads under the cashier token that carried it',
    approvedVoid.body?.results?.[0]?.status === 'accepted',
    JSON.stringify(approvedVoid.body?.results?.[0]),
  );
  check(
    'the void put the stock back',
    (await levelOf()) === beforeOfflineVoid + 1,
    `expected ${beforeOfflineVoid + 1}, got ${await levelOf()}`,
  );

  const refundKindTotal = async () => {
    const status = await api(`/api/v1/cash/sessions/${sessionId}`, { token: managerToken });
    const row = (status.body?.breakdown ?? []).find((b) => b.kind === 'refund');
    return BigInt(row?.total ?? '0');
  };
  check(
    'voiding a cash sale took the money back out of the drawer',
    (await refundKindTotal()) === drawerBeforeVoid - 2705n,
    `refund total went from ${drawerBeforeVoid} to ${await refundKindTotal()}`,
  );

  const replayedVoid = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: voidEnvelope(voidId, ownerId),
  });
  check(
    'a replayed void is a duplicate, not a second restock',
    replayedVoid.body?.results?.[0]?.status === 'duplicate',
    JSON.stringify(replayedVoid.body?.results?.[0]),
  );
  check(
    'the replayed void did not restock twice',
    (await levelOf()) === beforeOfflineVoid + 1,
  );

  // The sale and its void are ordered inside a batch but not across batches.
  // A void for a sale that has not arrived must wait, not dead letter: the
  // alternative is a sale left standing that a manager already voided.
  const orphanVoid = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: {
      register_id: registerId,
      device_id: randomUUID(),
      entities: [
        {
          id: uuidV7(),
          entity_type: 'sale_void',
          device_time: new Date().toISOString(),
          payload: {
            sale_id: uuidV7(),
            cashier_user_id: cashierId,
            approved_by: ownerId,
            reason: 'its sale has not uploaded yet',
            device_time: new Date().toISOString(),
          },
        },
      ],
    },
  });
  check(
    'a void whose sale has not arrived waits instead of being rejected',
    orphanVoid.body?.results?.[0]?.error?.retryable === true,
    JSON.stringify(orphanVoid.body?.results?.[0]),
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

  // 20000 float + 5410 sale + 2705 sale + 2705 sale
  //   - 2500 paid out - 2705 refund - 2705 void - 2705 void = 20205.
  //
  // Two of those sales were voided, and each contributes nothing on balance:
  // the cash went into the drawer and came straight back out. Before voiding
  // reversed its cash the drawer was expected to hold that money, so every
  // voided cash sale read **over** by its own amount at close — and a cashier
  // who voided a sale and pocketed the notes produced a drawer that balanced
  // perfectly.
  //
  // The voided sale contributes nothing on balance, which is the point: its
  // cash went into the drawer and came straight back out. Before the reversal
  // existed the drawer was expected to hold that money, so every voided cash
  // sale read **over** by its own amount at close — and a cashier who voided a
  // sale and pocketed the notes produced a drawer that balanced perfectly.
  check(
    'expected cash is the sum of every movement',
    closed.body?.expected_minor === '20205',
    `expected_minor was ${closed.body?.expected_minor}`,
  );
  check(
    'counting 20000 against 20205 reports short, by the difference',
    closed.body?.outcome === 'short' && closed.body?.variance_minor === '-205',
    JSON.stringify(closed.body),
  );

  const closeAgain = await api(`/api/v1/cash/sessions/${sessionId}/close`, {
    token: managerToken,
    method: 'POST',
    body: { counted_minor: '20205' },
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

  // ------------------------------------------------- 8. the register bootstrap

  const snapshot = await api(`/api/v1/sync/catalog?store_id=${storeId}`, { token: cashierToken });
  check('a register can pull a catalog snapshot', snapshot.status === 200, JSON.stringify(snapshot.body).slice(0, 200));

  // An empty snapshot delivered with a 200 is the worst possible answer: the
  // register looks provisioned, shows "no staff on this register yet", and
  // cannot open the till. Both ways of asking for the wrong thing must fail
  // loudly instead.
  const noStore = await api('/api/v1/sync/catalog', { token: cashierToken });
  check(
    'a catalog snapshot without a store is refused, not answered emptily',
    noStore.status === 400,
    `status ${noStore.status}, employees ${noStore.body?.employees?.length}`,
  );

  const wrongStore = await api(
    `/api/v1/sync/catalog?store_id=${randomUUID()}`,
    { token: cashierToken },
  );
  check(
    'a catalog snapshot for a store in no org is refused, not answered emptily',
    wrongStore.status === 404,
    `status ${wrongStore.status}, employees ${wrongStore.body?.employees?.length}`,
  );
  check(
    'the snapshot carries everything needed to sell offline',
    snapshot.body?.variants?.length === 12 &&
      snapshot.body?.barcodes?.length === 12 &&
      snapshot.body?.prices?.length >= 12 &&
      snapshot.body?.categories?.length === 8 &&
      snapshot.body?.tax_rates?.length >= 1,
    JSON.stringify({
      variants: snapshot.body?.variants?.length,
      barcodes: snapshot.body?.barcodes?.length,
      prices: snapshot.body?.prices?.length,
      categories: snapshot.body?.categories?.length,
      taxRates: snapshot.body?.tax_rates?.length,
    }),
  );
  check(
    'the snapshot carries the age rule with each variant',
    snapshot.body?.variants?.find((v) => v.sku === 'GB-PULSEX-MM')?.minimum_age === 21 &&
      snapshot.body?.variants?.find((v) => v.sku === 'MON-ULTRA-16')?.minimum_age === null,
  );
  check(
    'the snapshot carries a cursor to resume the change feed from',
    /^\d+$/.test(snapshot.body?.cursor ?? ''),
    `cursor was ${snapshot.body?.cursor}`,
  );
  check(
    'a bootstrap identifies every projection it contains',
    ['catalog', 'prices', 'tax', 'employees', 'inventory'].every((scope) =>
      snapshot.body?.included_scopes?.includes(scope)),
    JSON.stringify(snapshot.body?.included_scopes),
  );

  const unchangedDelta = await api(
    `/api/v1/sync/catalog?store_id=${storeId}&since=${snapshot.body?.cursor}`,
    { token: cashierToken },
  );
  check(
    'an unchanged incremental pull transfers no projections',
    unchangedDelta.status === 200 &&
      unchangedDelta.body?.included_scopes?.length === 0 &&
      unchangedDelta.body?.variants?.length === 0 &&
      unchangedDelta.body?.prices?.length === 0 &&
      unchangedDelta.body?.employees?.length === 0,
    JSON.stringify(unchangedDelta.body?.included_scopes),
  );
  check(
    'an unchanged pull keeps the cursor stable',
    unchangedDelta.body?.cursor === snapshot.body?.cursor,
    `${snapshot.body?.cursor} -> ${unchangedDelta.body?.cursor}`,
  );

  // Write through the same non-owner role production uses. This is test setup,
  // not a back door in the API, and it proves a price-only transaction returns
  // prices without retransferring products, barcodes, inventory or staff.
  const direct = new pg.Pool({
    connectionString: process.env.E2E_DATABASE_URL ??
      'postgres://snappos_app:dev_only_not_a_secret@localhost:5432/snappos_e2e',
  });
  const client = await direct.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [ownerSession.body?.org_id]);
    await client.query(
      `UPDATE variant_prices SET price_minor = price_minor + 1
       WHERE id = (SELECT id FROM variant_prices WHERE variant_id = $1 LIMIT 1)`,
      [variantId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await direct.end();
  }

  const priceDelta = await api(
    `/api/v1/sync/catalog?store_id=${storeId}&since=${snapshot.body?.cursor}`,
    { token: cashierToken },
  );
  check(
    'a price-only change returns only the price projection',
    priceDelta.status === 200 &&
      JSON.stringify(priceDelta.body?.included_scopes) === JSON.stringify(['prices']) &&
      priceDelta.body?.prices?.length >= 12 &&
      priceDelta.body?.variants?.length === 0 &&
      priceDelta.body?.barcodes?.length === 0 &&
      priceDelta.body?.employees?.length === 0,
    JSON.stringify({
      scopes: priceDelta.body?.included_scopes,
      prices: priceDelta.body?.prices?.length,
      variants: priceDelta.body?.variants?.length,
    }),
  );

  const aheadDelta = await api(
    `/api/v1/sync/catalog?store_id=${storeId}&since=9223372036854775807`,
    { token: cashierToken },
  );
  check(
    'a cursor from a reset database forces bootstrap instead of preserving stale rows',
    aheadDelta.status === 200 && aheadDelta.body?.included_scopes?.includes('catalog') &&
      aheadDelta.body?.variants?.length === snapshot.body?.variants?.length,
    JSON.stringify(aheadDelta.body?.included_scopes),
  );
  // A terminal can be stolen, so it holds the smallest useful copy.
  check(
    'the snapshot contains no customer data',
    !('customers' in (snapshot.body ?? {})),
  );

  // Employees are replicated so PIN unlock works with no network, which is
  // exactly when a shift is most likely to start.
  const employees = snapshot.body?.employees ?? [];
  check(
    'the snapshot carries the staff who can unlock this register',
    employees.length === 3 && employees.every((e) => typeof e.pin_hash === 'string'),
    JSON.stringify(employees.map((e) => e.display_name)),
  );
  check(
    'a replicated employee carries a PIN hash and NEVER a password hash',
    employees.every(
      (e) =>
        e.pin_hash?.startsWith('$argon2') &&
        !('password_hash' in e) &&
        !('mfa_secret_enc' in e),
    ),
    JSON.stringify(Object.keys(employees[0] ?? {})),
  );
  check(
    'each employee carries the permissions the register enforces offline',
    employees.every((e) => Array.isArray(e.permissions)) &&
      employees.some((e) => e.permissions.includes('sale.create')),
  );

  // ------------------------------------------------------------- 9. audit trail

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
