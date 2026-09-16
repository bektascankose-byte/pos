// Schema invariants: the guarantees the database makes on its own, with no
// application code involved. If one of these fails, a bug that reaches it
// cannot be fixed in the API layer.
//
// Runs on PGlite by default and on real Postgres with SNAPPOS_TEST_ENGINE=postgres.
import { test } from 'node:test';
import { createScratchDatabase } from '../src/engine.mjs';

const scratch = await createScratchDatabase();
const db = scratch.db;

async function expectOk(name, fn) {
  await test(name, async () => { await fn(); });
}
async function expectReject(name, fn, needle) {
  await test(name, async () => {
    let threw = null;
    try { await fn(); } catch (e) { threw = e; }
    if (!threw) throw new Error('expected a rejection, got success');
    if (needle && !threw.message.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`rejected, but for the wrong reason: ${threw.message}`);
    }
  });
}

// ---------------------------------------------------------------- fixtures
const q = (sql, p) => db.query(sql, p);

const [org]  = await q(`insert into organizations (slug, legal_name, display_name)
                        values ('hh-smoke','Smoke & Vape Shop LLC','Smoke & Vape Shop') returning id`);
const [org2] = await q(`insert into organizations (slug, legal_name, display_name)
                        values ('other-co','Other Co','Other') returning id`);
const [store] = await q(`insert into stores (org_id, code, name, region, city, county)
                         values ($1,'HH01','Harker Heights','TX','Harker Heights','Bell') returning id`, [org.id]);
const [store2] = await q(`insert into stores (org_id, code, name) values ($1,'X1','Other Store') returning id`, [org2.id]);
const [reg]  = await q(`insert into registers (org_id, store_id, code, name)
                        values ($1,$2,'R1','Front Counter') returning id`, [org.id, store.id]);
const [user] = await q(`insert into users (org_id, email, full_name, display_name, status)
                        values ($1,'maria@example.com','Maria Lopez','Maria','active') returning id`, [org.id]);
const [txCat] = await q(`insert into tax_categories (org_id, code, name)
                         values ($1,'TOBACCO','Tobacco & Vapor') returning id`, [org.id]);
const [cat] = await q(`insert into categories (org_id, slug, name, path, depth)
                       values ($1,'disposable','Disposable Vapes','vapes.disposable',1) returning id`, [org.id]);
const [brand] = await q(`insert into brands (org_id, name, brand_family) values ($1,'Geek Bar','Geek Bar') returning id`, [org.id]);
const [prod] = await q(`insert into products (org_id, name, short_name, brand_id, category_id, tax_category_id, has_variants, variant_axes)
                        values ($1,'Geek Bar Pulse X','Geek Bar Pulse X',$2,$3,$4,true,'{flavor}') returning id`,
                        [org.id, brand.id, cat.id, txCat.id]);
const [v1] = await q(`insert into product_variants (org_id, product_id, sku, variant_name, attributes, cost, average_cost, case_quantity)
                      values ($1,$2,'GB-PX-MIAMI','Miami Mint','{"flavor":"Miami Mint"}',5.000000,5.000000,12) returning id`,
                      [org.id, prod.id]);
const [v2] = await q(`insert into product_variants (org_id, product_id, sku, variant_name, attributes, cost, average_cost, case_quantity)
                      values ($1,$2,'GB-PX-BLUE','Blue Razz','{"flavor":"Blue Razz"}',5.000000,5.000000,12) returning id`,
                      [org.id, prod.id]);
await q(`insert into variant_barcodes (org_id, variant_id, barcode, is_primary) values ($1,$2,'850043572091',true)`, [org.id, v1.id]);
await q(`insert into variant_prices (org_id, variant_id, kind, price_minor) values ($1,$2,'regular',2499)`, [org.id, v1.id]);
await q(`insert into inventory_levels (org_id, store_id, variant_id, on_hand) values ($1,$2,$3,12)`, [org.id, store.id, v1.id]);
await q(`insert into product_compliance (org_id, product_id, minimum_age, id_scan_required, regulated_class, contains_nicotine)
         values ($1,$2,21,true,'ends',true)`, [org.id, prod.id]);

console.log('\nINVARIANTS\n');

// ------------------------------------------------ 1. UUIDv7 is well formed
await expectOk('uuid_generate_v7 emits valid v7 values, monotonic within a millisecond', async () => {
  // 500 ids minted as fast as the server can produce them, which puts many of
  // them inside the same millisecond. They must still sort in creation order.
  const rows = await q(`select uuid_generate_v7()::text as u from generate_series(1, 500)`);
  const ids = rows.map(r => r.u);
  for (const u of ids) {
    if (u[14] !== '7') throw new Error(`version nibble is ${u[14]}, expected 7`);
    if (!'89ab'.includes(u[19])) throw new Error(`variant nibble is ${u[19]}, expected 8-b`);
  }
  if (new Set(ids).size !== ids.length) throw new Error('collision within the batch');
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i - 1] < ids[i])) {
      throw new Error(`not monotonic at index ${i}: ${ids[i - 1]} then ${ids[i]}`);
    }
  }
});

// ------------------------------------------------ 2. one barcode, one variant
await expectReject('a barcode cannot resolve to two variants in one org',
  () => q(`insert into variant_barcodes (org_id, variant_id, barcode) values ($1,$2,'850043572091')`, [org.id, v2.id]),
  'unique');

// ------------------------------------------------ 3. cross tenant references
await expectReject('a register cannot point at a store in another organization',
  () => q(`insert into registers (org_id, store_id, code, name) values ($1,$2,'R9','Cross tenant')`, [org.id, store2.id]),
  'foreign key');

// ------------------------------------------------ 4. one open drawer per register
const [sess] = await q(`insert into cash_sessions (org_id, store_id, register_id, opened_by, opening_float_minor)
                        values ($1,$2,$3,$4,15000) returning id`, [org.id, store.id, reg.id, user.id]);
await expectReject('a register cannot have two open cash sessions',
  () => q(`insert into cash_sessions (org_id, store_id, register_id, opened_by) values ($1,$2,$3,$4)`,
          [org.id, store.id, reg.id, user.id]),
  'unique');

// ------------------------------------------------ 5. ring a sale, offline style
const saleId = (await q(`select uuid_generate_v7() as id`))[0].id;
const lineId = (await q(`select uuid_generate_v7() as id`))[0].id;
const payId  = (await q(`select uuid_generate_v7() as id`))[0].id;

const ringSale = async () => {
  await db.exec('BEGIN');
  await q(`insert into sales (id, org_id, store_id, register_id, session_id, cashier_user_id,
             receipt_no, register_sequence, subtotal_minor, tax_minor, total_minor, cost_total,
             device_time, completed_at)
           values ($1,$2,$3,$4,$5,$6,'HH01-R1-000001',1,4998,412,5410,10.000000, now(), now())
           on conflict (id) do nothing`,
          [saleId, org.id, store.id, reg.id, sess.id, user.id]);
  await q(`insert into sale_lines (id, org_id, sale_id, line_no, variant_id, description, sku_snapshot,
             quantity, unit_price_minor, original_price_minor, tax_minor, total_minor, unit_cost)
           values ($1,$2,$3,1,$4,'Geek Bar Pulse X Miami Mint','GB-PX-MIAMI',2,2499,2499,412,5410,5.000000)
           on conflict (id) do nothing`, [lineId, org.id, saleId, v1.id]);
  await q(`insert into payments (id, org_id, sale_id, method, amount_minor, tendered_minor, change_minor,
             device_time, captured_at)
           values ($1,$2,$3,'cash',5410,6000,590, now(), now()) on conflict (id) do nothing`,
          [payId, org.id, saleId]);
  // Deterministic id + deterministic occurred_at => replay safe at the DB level.
  await q(`insert into inventory_ledger (id, occurred_at, org_id, store_id, variant_id, delta, reason,
             unit_cost, reference_type, reference_id, actor_user_id)
           select $1, s.completed_at, $2, $3, $4, -2, 'sale', 5.000000, 'sale_line', $1, $5
           from sales s where s.id = $6
           on conflict (id, occurred_at) do nothing`,
          [lineId, org.id, store.id, v1.id, user.id, saleId]);
  await q(`update inventory_levels set on_hand = on_hand - 2, last_sold_at = now()
           where store_id=$1 and variant_id=$2`, [store.id, v1.id]);
  await db.exec('COMMIT');
};

await expectOk('a sale commits with lines, payment and a ledger entry in one transaction', ringSale);

// ------------------------------------------------ 6. THE critical one
await expectOk('re-uploading the same sale is a no-op, not a duplicate', async () => {
  await ringSale();                       // simulate a retried sync batch
  await ringSale();                       // and again
  const [{ sales, lines, pays }] = await q(`
    select (select count(*) from sales where id=$1) as sales,
           (select count(*) from sale_lines where sale_id=$1) as lines,
           (select count(*) from payments where sale_id=$1) as pays`, [saleId]);
  if (+sales !== 1 || +lines !== 1 || +pays !== 1)
    throw new Error(`duplicated: ${sales} sales, ${lines} lines, ${pays} payments`);
});

// The important one: three UNCONDITIONAL replays of the whole intake path still
// produce exactly one stock movement, with no short circuit logic involved.
await expectOk('replayed sync cannot double count stock (deterministic ledger id)', async () => {
  const [{ n, total }] = await q(
    `select count(*) as n, coalesce(sum(delta),0) as total
       from inventory_ledger where reference_id=$1`, [lineId]);
  if (+n !== 1) throw new Error(`expected 1 ledger row after 3 replays, saw ${n}`);
  if (Number(total) !== -2) throw new Error(`stock moved ${total}, expected -2`);
});

// ------------------------------------------------ 7. immutability
await expectReject('a completed sale total cannot be edited',
  () => q(`update sales set total_minor = 1 where id=$1`, [saleId]),
  'immutable');

await expectReject('a sale line price cannot be edited',
  () => q(`update sale_lines set unit_price_minor = 1 where id=$1`, [lineId]),
  'immutable');

await expectReject('a sale cannot be deleted',
  () => q(`delete from sales where id=$1`, [saleId]),
  'cannot be deleted');

await expectOk('voiding a sale is a permitted transition', () =>
  q(`update sales set status='voided', voided_at=now(), voided_by=$2, void_reason='customer changed mind'
     where id=$1`, [saleId, user.id]));

await expectOk('quantity_refunded is the one mutable column on a line', () =>
  q(`update sale_lines set quantity_refunded = 1 where id=$1`, [lineId]));

// ------------------------------------------------ 8. refund bounds
await expectReject('cannot refund more units than were sold',
  () => q(`update sale_lines set quantity_refunded = 5 where id=$1`, [lineId]),
  'sale_line_refund_bound');

// ------------------------------------------------ 9. inventory semantics
await expectOk('on_hand MAY go negative (two offline registers sold the last unit)', () =>
  q(`update inventory_levels set on_hand = -1 where store_id=$1 and variant_id=$2`, [store.id, v1.id]));

await expectReject('reserved may NOT go negative',
  () => q(`update inventory_levels set reserved = -1 where store_id=$1 and variant_id=$2`, [store.id, v1.id]),
  'inventory_reserved_nonneg');

await expectOk('available is derived, never stored by hand', async () => {
  await q(`update inventory_levels set on_hand = 10, reserved = 3 where store_id=$1 and variant_id=$2`, [store.id, v1.id]);
  const [{ available }] = await q(`select available from inventory_levels where store_id=$1 and variant_id=$2`, [store.id, v1.id]);
  if (Number(available) !== 7) throw new Error(`available = ${available}, expected 7`);
});

await expectReject('a ledger entry with a zero delta is meaningless and rejected',
  () => q(`insert into inventory_ledger (org_id, store_id, variant_id, delta, reason)
           values ($1,$2,$3,0,'manual_adjustment')`, [org.id, store.id, v1.id]),
  'ledger_delta_nonzero');

await expectOk('ledger rows route to the correct monthly partition', async () => {
  const [{ part }] = await q(`
    select c.relname as part from inventory_ledger l
    join pg_class c on c.oid = l.tableoid
    where l.reference_id = $1 limit 1`, [lineId]);
  const expected = `inventory_ledger_p${new Date().toISOString().slice(0,7).replace('-','')}`;
  if (part !== expected) throw new Error(`landed in ${part}, expected ${expected}`);
});

// ------------------------------------------------ 10. no card data
await expectReject('a payment cannot store anything longer than four digits as card_last4',
  () => q(`insert into payments (id, org_id, sale_id, method, amount_minor, card_last4, device_time)
           values (uuid_generate_v7(),$1,$2,'card',100,'4111111111111111', now())`, [org.id, saleId]),
  'value too long');

await expectReject('a payment must belong to exactly one of a sale or a refund',
  () => q(`insert into payments (id, org_id, method, amount_minor, device_time)
           values (uuid_generate_v7(),$1,'cash',100, now())`, [org.id]),
  'payment_target');

// ------------------------------------------------ 11. compliance and consent
await expectOk('an age check stores metadata only, never identity', async () => {
  await q(`insert into age_verifications (org_id, store_id, register_id, sale_id, method, result,
             minimum_age_applied, employee_user_id)
           values ($1,$2,$3,$4,'scan','pass',21,$5)`, [org.id, store.id, reg.id, saleId, user.id]);
  const cols = await q(`select column_name from information_schema.columns
                        where table_name='age_verifications'`);
  const names = cols.map(c => c.column_name).join(' ');
  for (const forbidden of ['name','address','license','dob','birth','image','document']) {
    if (names.includes(forbidden)) throw new Error(`age_verifications exposes a '${forbidden}' column`);
  }
});

await expectOk('platform compliance rules are visible to every org (nullable org_id)', async () => {
  const [{ n }] = await q(`select count(*) as n from compliance_rules where org_id is null`);
  if (+n < 7) throw new Error(`expected the platform baseline rules, saw ${n}`);
});

await expectReject('a require_age rule must carry an age',
  () => q(`insert into compliance_rules (name, effect) values ('bad rule','require_age')`),
  'compliance_age_present');

// ------------------------------------------------ 12. sync plumbing
await expectOk('the change_log watermark function evaluates', async () => {
  await q(`insert into change_log (org_id, store_id, entity_type, entity_id, op)
           values ($1,$2,'product_variant',$3,'update')`, [org.id, store.id, v1.id]);
  const [{ w }] = await q(`select sync_changes_watermark() as w`);
  if (w === null || w === undefined) throw new Error('watermark returned null');
});

await expectOk('idempotency keys are unique per org and key', async () => {
  await q(`insert into idempotency_keys (org_id, key, endpoint, request_hash)
           values ($1,'abc','/v1/sales','h1')`, [org.id]);
  try {
    await q(`insert into idempotency_keys (org_id, key, endpoint, request_hash)
             values ($1,'abc','/v1/sales','h1')`, [org.id]);
    throw new Error('duplicate key was accepted');
  } catch (e) {
    if (!e.message.includes('duplicate key')) throw e;
  }
});

// ------------------------------------------------ 13. RLS is armed
await expectOk('row level security is enabled on every tenant table', async () => {
  const missing = await q(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='org_id' and a.attnum>0
    where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition
      and c.relrowsecurity = false`);
  if (missing.length) throw new Error(`RLS missing on: ${missing.map(r => r.relname).join(', ')}`);
});

// ------------------------------------------------ 14. Views cannot leak past RLS
//
// A Postgres view runs with its OWNER's rights by default, and every object
// here is owned by the migrator role, which carries BYPASSRLS. A view over a
// tenant table without `security_invoker` therefore serves every
// organization's rows to any caller -- a hole the table underneath cannot
// open on its own. This caught exactly that on `storefront_availability`
// during phase 2, so it is asserted rather than remembered.
await expectOk('every view over a tenant table runs as the caller, not its owner', async () => {
  const leaky = await q(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce((
        select option_value = 'true'
        from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker'
      ), false)`);
  if (leaky.length) {
    throw new Error(
      `views missing security_invoker: ${leaky.map(r => r.relname).join(', ')}`,
    );
  }
});

// ------------------------------------------------ 15. an order is not a sale
//
// An online order claims stock without moving it, and produces a sale at
// handover. The one fact everything else hangs off is that "completed" and
// "has a sale" are the same fact: a completed order without a sale is stock
// that left with nothing to explain it, and a sale on an order that was never
// handed over is the reverse. The API funnels every move through the state
// machine, but these hold even for a write that skips it.
const orderInsert = (extra = {}) => {
  const row = {
    org_id: org.id, store_id: store.id, order_number: 'HH01-0916-001', fulfilment: 'pickup',
    guest_name: 'Dana Ruiz', guest_email: 'dana@example.test', ...extra,
  };
  const cols = Object.keys(row);
  return q(`insert into orders (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
           Object.values(row));
};

const [order] = await orderInsert();

await expectReject('an order with no customer and no way to reach a guest is refused',
  () => orderInsert({ order_number: 'HH01-0916-002', guest_email: null }),
  'orders_has_somebody');

await expectReject('an order cannot be completed without the sale that explains the stock',
  () => q(`update orders set status='completed', completed_at=now() where id=$1`, [order.id]),
  'orders_completed_has_sale');

await expectReject('a sale cannot be attached to an order that was never handed over',
  () => q(`update orders set sale_id=$1 where id=$2`, [saleId, order.id]),
  'orders_completed_has_sale');

await expectReject('a completed order must say when it completed',
  () => q(`update orders set status='completed', sale_id=$1 where id=$2`, [saleId, order.id]),
  'orders_completed_at_set');

await expectOk('handover sets status, sale and time together', () =>
  q(`update orders set status='completed', sale_id=$1, completed_at=now() where id=$2`, [saleId, order.id]));

await expectReject('order numbers are unique per org regardless of case',
  () => orderInsert({ order_number: 'hh01-0916-001' }),
  'orders_number_key');

const [orderLine] = await q(
  `insert into order_lines (org_id, order_id, variant_id, quantity, unit_price_minor, line_total_minor,
     description, upc_snapshot)
   values ($1,$2,$3,1,2499,2499,'Geek Bar Pulse X Miami Mint','850043572091') returning id`,
  [org.id, order.id, v1.id]);

await expectReject('a line cannot be taken off an order without saying why — the customer reads it',
  () => q(`update order_lines set removed_at=now(), removed_reason='  ' where id=$1`, [orderLine.id]),
  'order_line_removed_explained');

await expectReject('an order line must be for something',
  () => q(`insert into order_lines (org_id, order_id, variant_id, quantity, unit_price_minor, line_total_minor,
             description, upc_snapshot) values ($1,$2,$3,0,2499,0,'x','x')`, [org.id, order.id, v1.id]),
  'check');

await expectOk('the order status vocabulary is the one the state machine was written against', async () => {
  // Pinned so a status added in a migration is a deliberate, reviewed change
  // to `ORDER_STATUSES` in `packages/contracts/src/order-state.ts` and its transition table, rather
  // than a value the database accepts and the lifecycle has never heard of.
  const [{ labels }] = await q(`select array_to_string(enum_range(null::order_status), ',') as labels`);
  const expected = [
    'placed', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled',
    'pending_payment', 'payment_failed', 'courier_requested', 'in_transit',
    'delivery_failed', 'returned_to_store',
  ].join(',');
  if (labels !== expected) throw new Error(`order_status is\n  ${labels}\nexpected\n  ${expected}`);
});

await scratch.drop();
