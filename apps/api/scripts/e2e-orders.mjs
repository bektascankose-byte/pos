#!/usr/bin/env node
/**
 * Online orders, end to end.
 *
 * Lists an item for pickup, places an order against it, and walks the order to
 * handover the way the back office does. What it is really checking is the set
 * of things that went wrong while this was being built, none of which a unit
 * test or the type checker noticed:
 *
 * - the compliance engine fails closed, and a refusal is *kept* -- a refusal
 *   thrown inside the transaction that recorded it used to roll the record back
 * - every status change goes through the database, not just the first one -- a
 *   parameter used as both an enum and a comparison once failed every accept
 * - handover writes a complete sale -- a cast once skipped the schema defaults
 *   and tried to put nulls into NOT NULL columns
 * - an online sale never takes a counter register's numbers -- a phone numbers
 *   its own sales offline, so a server-issued number on its register is the
 *   number its next real sale gets refused for
 *
 * Imported by e2e.mjs after the counter checks, sharing their server and reset.
 */

import pg from 'pg';

export async function runOrderChecks({ api, check, ownerToken, managerToken, cashierToken, storeId }) {
  // ------------------------------------------------------------------ context

  const ownerSession = await api('/api/v1/auth/session', { token: ownerToken });
  const orgId = ownerSession.body?.org_id;

  // Blue Razz Ice: seeded with 18 and untouched by the counter checks, so the
  // stock figures here are this section's alone.
  const scan = await api(`/api/v1/catalog/scan/840216300118?store_id=${storeId}`, {
    token: cashierToken,
  });
  const variantId = scan.body?.variant_id;
  check('the order item resolves from its UPC', typeof variantId === 'string', JSON.stringify(scan.body));

  const levelOf = async () => {
    const r = await api(`/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`, {
      token: ownerToken,
    });
    return Number(r.body?.[0]?.on_hand ?? NaN);
  };

  const tillSequence = async (code) => {
    const r = await api('/api/v1/registers', { token: cashierToken });
    return r.body?.data?.find((register) => register.code === code)?.last_sequence;
  };

  // Written through the same non-owner role production uses, under the org's
  // own context, so row level security applies exactly as it does in the API.
  const direct = new pg.Pool({
    connectionString:
      process.env.E2E_DATABASE_URL ??
      'postgres://snappos_app:dev_only_not_a_secret@localhost:5432/snappos_e2e',
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

  const guest = { guest_name: 'Dana Ruiz', guest_email: 'dana@example.test' };
  const place = (quantity, token = ownerToken) =>
    api('/api/v1/orders', {
      token,
      method: 'POST',
      body: { store_id: storeId, fulfilment: 'pickup', ...guest, lines: [{ variant_id: variantId, quantity }] },
    });

  try {
    // ------------------------------------------------ 1. list it for pickup

    const listed = await api(`/api/v1/storefront/listings/${variantId}`, {
      token: ownerToken,
      method: 'POST',
      body: { availability: 'pickup_only' },
    });
    check('an item can be listed for pickup', listed.status === 201, JSON.stringify(listed.body));

    // --------------------------------------- 2. compliance fails closed, and says so

    const refused = await place('1');
    check(
      'with no rule allowing pickup, an order is refused',
      refused.status === 400 && refused.body?.code === 'validation_failed',
      `${refused.status} ${JSON.stringify(refused.body)}`,
    );
    const kept = await sql(
      `SELECT count(*)::int AS n FROM compliance_decisions
       WHERE variant_id = $1 AND allowed = false AND order_id IS NULL`,
      [variantId],
    );
    check(
      'the refusal is kept, not rolled back with the order it refused',
      kept[0]?.n === 1,
      `found ${kept[0]?.n} refused decisions`,
    );

    await sql(
      `INSERT INTO compliance_rules (org_id, name, priority, scope_country, channel, effect, authority_note)
       VALUES ($1, 'E2E pickup allowed', 0, 'US', 'pickup', 'allow', 'End to end fixture.')`,
      [orgId],
    );

    // ------------------------------------------ 3. placing claims, it does not move

    const before = await levelOf();
    const r1Before = await tillSequence('R1');

    const placed = await place('2');
    const order = placed.body;
    check('an order is placed', placed.status === 201 && order?.status === 'placed', JSON.stringify(order));

    // The seeded store keeps Chicago time. Its evening orders must carry its
    // own date, and the year, or next year's first order repeats this one's
    // number and is refused.
    const shopDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: '2-digit', month: '2-digit', day: '2-digit',
    }).format(new Date()).replaceAll('-', '');
    check(
      "order numbers carry the shop's own date, with the year, counting from 001",
      order?.order_number === `HH01-${shopDay}-001`,
      `got ${order?.order_number}, expected HH01-${shopDay}-001`,
    );
    check(
      'the order is priced from its lines',
      order?.lines?.length === 1 &&
        BigInt(order.lines[0].line_total_minor) === 2n * BigInt(order.lines[0].unit_price_minor) &&
        order.total_minor === order.lines[0].line_total_minor,
      JSON.stringify(order?.lines),
    );
    check('placing an order does not move stock', (await levelOf()) === before, `was ${before}`);

    const queue = await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken });
    check(
      'a cashier sees the order in the queue',
      queue.status === 200 && queue.body?.some((entry) => entry.id === order?.id),
      JSON.stringify(queue.body),
    );

    // --------------------------------------------- 4. the lifecycle refuses shortcuts

    const early = await api(`/api/v1/orders/${order?.id}/complete`, {
      token: cashierToken,
      method: 'POST',
      body: { tender: 'cash' },
    });
    check(
      'an order cannot be handed over before it is accepted',
      early.status === 409 && /can only become/i.test(early.body?.message ?? ''),
      `${early.status} ${JSON.stringify(early.body)}`,
    );

    const silentReject = await api(`/api/v1/orders/${order?.id}/reject`, {
      token: cashierToken,
      method: 'POST',
      body: {},
    });
    check(
      'rejecting without a reason is refused — the customer is told the reason',
      silentReject.status === 400,
      `${silentReject.status} ${JSON.stringify(silentReject.body)}`,
    );

    // ------------------------------------------- 5. accept, ready, and hand over

    const accepted = await api(`/api/v1/orders/${order?.id}/accept`, { token: cashierToken, method: 'POST' });
    check('a cashier can accept an order', accepted.status === 201 && accepted.body?.status === 'accepted',
          `${accepted.status} ${JSON.stringify(accepted.body)}`);

    const ready = await api(`/api/v1/orders/${order?.id}/ready`, { token: cashierToken, method: 'POST' });
    check('preparing is optional: accepted can go straight to ready',
          ready.status === 201 && ready.body?.status === 'ready',
          `${ready.status} ${JSON.stringify(ready.body)}`);

    const cashierCancel = await api(`/api/v1/orders/${order?.id}/cancel`, {
      token: cashierToken,
      method: 'POST',
      body: { reason: 'changed my mind' },
    });
    check('a cashier cannot cancel an order staff have already taken', cashierCancel.status === 403,
          `${cashierCancel.status} ${JSON.stringify(cashierCancel.body)}`);

    const handed = await api(`/api/v1/orders/${order?.id}/complete`, {
      token: cashierToken,
      method: 'POST',
      body: { tender: 'card' },
    });
    check(
      'handover completes the order and writes a sale',
      handed.status === 201 && handed.body?.status === 'completed' && typeof handed.body?.sale_id === 'string',
      `${handed.status} ${JSON.stringify(handed.body)}`,
    );
    check('stock moves at handover, by exactly what was ordered', (await levelOf()) === before - 2,
          `expected ${before - 2}`);

    const again = await api(`/api/v1/orders/${order?.id}/complete`, {
      token: cashierToken,
      method: 'POST',
      body: { tender: 'card' },
    });
    const [written] = await sql(
      `WITH written AS (
         SELECT s.id, s.channel::text AS channel, s.register_sequence::int AS sequence,
                r.code AS register_code, r.config->>'kind' AS register_kind
         FROM sales s JOIN registers r ON r.id = s.register_id
         WHERE s.receipt_no = $1
       )
       SELECT (SELECT count(*)::int FROM written) AS sales,
              w.register_code, w.register_kind, w.sequence, w.channel,
              (SELECT count(*)::int FROM payments p WHERE p.sale_id IN (SELECT id FROM written)) AS payments
       FROM written w
       LIMIT 1`,
      [order?.order_number],
    );
    check('handing over twice is refused, and makes one sale', again.status === 409 && written?.sales === 1,
          `${again.status}, ${written?.sales} sales`);
    check('the sale records its tender and its channel', written?.payments === 1 && written?.channel === 'pickup',
          JSON.stringify(written));

    // ---------------------------------------- 6. never a counter register's numbers

    check(
      'an online sale is numbered on the online register, from 1',
      written?.register_code === 'ONLINE' && written?.register_kind === 'online' && written?.sequence === 1,
      JSON.stringify(written),
    );
    check(
      "handover does not use up a number the counter's phone is about to issue",
      (await tillSequence('R1')) === r1Before,
      `R1 was at ${r1Before}, now ${await tillSequence('R1')}`,
    );
    const tills = await api('/api/v1/registers', { token: cashierToken });
    check(
      'a phone cannot sign in to the online register',
      tills.status === 200 && !tills.body?.data?.some((register) => register.code === 'ONLINE'),
      JSON.stringify(tills.body?.data?.map((register) => register.code)),
    );

    const detail = await api(`/api/v1/orders/${order?.id}`, { token: cashierToken });
    check(
      'the timeline records every step, in order',
      JSON.stringify(detail.body?.events?.map((event) => event.to_status)) ===
        JSON.stringify(['placed', 'accepted', 'ready', 'completed']),
      JSON.stringify(detail.body?.events),
    );

    // ------------------------------------------------ 7. a line that can't be filled

    const short = (await place('1')).body;
    const lineId = short?.lines?.[0]?.id;
    const unexplained = await api(`/api/v1/orders/${short?.id}/lines/${lineId}/remove`, {
      token: cashierToken,
      method: 'POST',
      body: { reason: '' },
    });
    check('a line cannot come off without a reason', unexplained.status === 400,
          `${unexplained.status} ${JSON.stringify(unexplained.body)}`);

    const removed = await api(`/api/v1/orders/${short?.id}/lines/${lineId}/remove`, {
      token: cashierToken,
      method: 'POST',
      body: { reason: 'Out of stock' },
    });
    check(
      'a line that cannot be filled is marked, kept, and taken off the total',
      removed.status === 201 &&
        removed.body?.lines?.length === 1 &&
        removed.body.lines[0].removed_reason === 'Out of stock' &&
        removed.body.total_minor === '0',
      `${removed.status} ${JSON.stringify(removed.body)}`,
    );

    await api(`/api/v1/orders/${short?.id}/accept`, { token: cashierToken, method: 'POST' });
    await api(`/api/v1/orders/${short?.id}/ready`, { token: cashierToken, method: 'POST' });
    const nothing = await api(`/api/v1/orders/${short?.id}/complete`, {
      token: cashierToken,
      method: 'POST',
      body: { tender: 'cash' },
    });
    check('an order with every line removed cannot be handed over', nothing.status === 409,
          `${nothing.status} ${JSON.stringify(nothing.body)}`);

    // --------------------------------------------------------- 8. calling it off

    const unexplainedCancel = await api(`/api/v1/orders/${short?.id}/cancel`, {
      token: managerToken,
      method: 'POST',
      body: {},
    });
    check('cancelling without a reason is refused', unexplainedCancel.status === 400,
          `${unexplainedCancel.status} ${JSON.stringify(unexplainedCancel.body)}`);

    const stockBeforeCancel = await levelOf();
    const cancelled = await api(`/api/v1/orders/${short?.id}/cancel`, {
      token: managerToken,
      method: 'POST',
      body: { reason: 'The last one sold at the counter.' },
    });
    check(
      'a manager can cancel, and the customer is told why',
      cancelled.status === 201 &&
        cancelled.body?.status === 'cancelled' &&
        cancelled.body?.resolution_note === 'The last one sold at the counter.',
      `${cancelled.status} ${JSON.stringify(cancelled.body)}`,
    );
    check('cancelling moves no stock — nothing had moved to put back', (await levelOf()) === stockBeforeCancel);

    const revived = await api(`/api/v1/orders/${short?.id}/accept`, { token: managerToken, method: 'POST' });
    check('a cancelled order is final', revived.status === 409, `${revived.status} ${JSON.stringify(revived.body)}`);

    const stillQueued = await api(`/api/v1/orders?store_id=${storeId}`, { token: cashierToken });
    check(
      'finished orders leave the queue',
      stillQueued.status === 200 && !stillQueued.body?.some((entry) => entry.id === order?.id || entry.id === short?.id),
      JSON.stringify(stillQueued.body?.map((entry) => entry.order_number)),
    );
  } finally {
    await direct.end();
  }
}
