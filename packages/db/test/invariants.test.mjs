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

// ------------------------------------------------ 16. carts, shop keys, customer sessions
//
// The website's own rows. Each check is a rule that holds no matter which code
// path writes: one order per cart is what turns a double-clicked Place Order
// into one order, and a revoked shop key must stop resolving the moment it is
// revoked, not whenever a cache happens to notice.
const [cart] = await q(
  `insert into carts (org_id, store_id, token_hash, expires_at)
   values ($1,$2,'cart-hash-1', now() + interval '30 days') returning id`,
  [org.id, store.id]);

await expectOk('a cart holds an item', () =>
  q(`insert into cart_lines (org_id, cart_id, variant_id, quantity) values ($1,$2,$3,2)`, [org.id, cart.id, v1.id]));

await expectReject('adding the same item again changes the quantity, not the line count',
  () => q(`insert into cart_lines (org_id, cart_id, variant_id, quantity) values ($1,$2,$3,1)`, [org.id, cart.id, v1.id]),
  'cart_lines_cart_id_variant_id_key');

await expectReject('a cart line must be for at least something',
  () => q(`update cart_lines set quantity = 0 where cart_id = $1`, [cart.id]),
  'cart_lines_quantity_check');

await expectOk('checkout marks the cart with the order it became', () =>
  q(`update carts set converted_order_id = $1 where id = $2`, [order.id, cart.id]));

await expectReject('two carts cannot become the same order',
  async () => {
    const [second] = await q(
      `insert into carts (org_id, store_id, token_hash, expires_at)
       values ($1,$2,'cart-hash-2', now() + interval '30 days') returning id`, [org.id, store.id]);
    await q(`update carts set converted_order_id = $1 where id = $2`, [order.id, second.id]);
  },
  'carts_converted_order_key');

await expectReject('an order says where it came from, in words the system knows',
  () => q(`update orders set placed_via = 'fax' where id = $1`, [order.id]),
  'orders_placed_via_known');

const [shopper] = await q(
  `insert into customers (org_id, first_name, email) values ($1,'Dana','dana@example.test') returning id`, [org.id]);

await expectReject('a session cannot end before it began',
  () => q(`insert into customer_sessions (org_id, customer_id, token_hash, created_at, expires_at)
           values ($1,$2,'session-hash-1', now(), now() - interval '1 minute')`, [org.id, shopper.id]),
  'customer_sessions_expiry_after_start');

await expectReject('a one-time token cannot be issued already expired',
  () => q(`insert into customer_tokens (org_id, customer_id, purpose, token_hash, created_at, expires_at)
           values ($1,$2,'reset_password','token-hash-1', now(), now())`, [org.id, shopper.id]),
  'customer_tokens_expiry_after_start');

await expectOk('a shop key resolves to its store until it is revoked, and not a moment after', async () => {
  await q(`insert into storefront_clients (org_id, store_id, name, key_hash, key_prefix)
           values ($1,$2,'Website','shop-key-hash-1','sk_live_ab')`, [org.id, store.id]);
  const [found] = await q(`select org_id, store_id from shop_lookup_client('shop-key-hash-1')`);
  if (found?.org_id !== org.id || found?.store_id !== store.id) {
    throw new Error(`live key resolved to ${JSON.stringify(found)}`);
  }
  await q(`update storefront_clients set revoked_at = now() where key_hash = 'shop-key-hash-1'`);
  const afterRevoke = await q(`select * from shop_lookup_client('shop-key-hash-1')`);
  if (afterRevoke.length !== 0) throw new Error('a revoked key still resolves');
});

await expectReject('a shop key cannot be registered twice',
  () => q(`insert into storefront_clients (org_id, store_id, name, key_hash, key_prefix)
           values ($1,$2,'Copy','shop-key-hash-1','sk_live_ab')`, [org.id, store.id]),
  'storefront_clients_key_hash_key');

// ------------------------------------------------ 17. loyalty points are a ledger
//
// A balance is the sum of its history, and the history is not edited: a sale
// earns once however often its upload is replayed, a correction is a new entry
// with a reason, and nothing is deleted. The one change allowed is whose an
// entry is, for when an online account and an in-store record turn out to be
// the same person.
await expectOk('a completed sale earns points for its customer', () =>
  q(`insert into loyalty_ledger (org_id, customer_id, kind, points, sale_id, basis_minor, rate)
     values ($1,$2,'earn',39,$3,3998,1)`, [org.id, shopper.id, saleId]));

await expectReject('a sale earns once, however often its upload is replayed',
  () => q(`insert into loyalty_ledger (org_id, customer_id, kind, points, sale_id) values ($1,$2,'earn',39,$3)`,
          [org.id, shopper.id, saleId]),
  'loyalty_one_earn_per_sale');

await expectReject('earning is always a positive number of points from a sale',
  () => q(`insert into loyalty_ledger (org_id, customer_id, kind, points) values ($1,$2,'earn',10)`, [org.id, shopper.id]),
  'loyalty_earn_from_sale');

await expectReject('a person correcting a balance has to say why',
  () => q(`insert into loyalty_ledger (org_id, customer_id, kind, points, note) values ($1,$2,'adjust',-9,' ')`,
          [org.id, shopper.id]),
  'loyalty_adjust_explained');

await expectOk('a correction with a reason is recorded, and the balance is the sum of the history', async () => {
  await q(`insert into loyalty_ledger (org_id, customer_id, kind, points, note) values ($1,$2,'adjust',-9,'Duplicate scan at the counter')`,
          [org.id, shopper.id]);
  const [balance] = await q(`select points, lifetime_earned from loyalty_balances where customer_id = $1`, [shopper.id]);
  if (balance?.points !== 30 || balance?.lifetime_earned !== 39) {
    throw new Error(`balance ${JSON.stringify(balance)}, expected 30 points of 39 earned`);
  }
});

await expectReject('what an entry says cannot be edited afterwards',
  () => q(`update loyalty_ledger set points = 500 where customer_id = $1 and kind = 'earn'`, [shopper.id]),
  'cannot be edited');

await expectReject('points history cannot be deleted',
  () => q(`delete from loyalty_ledger where customer_id = $1`, [shopper.id]),
  'cannot be deleted');

const [inStoreMember] = await q(
  `insert into customers (org_id, first_name, phone) values ($1,'Dana','+12545550123') returning id`, [org.id]);

await expectOk('entries can move to another customer, for when two records turn out to be one person', () =>
  q(`update loyalty_ledger set customer_id = $1 where customer_id = $2`, [inStoreMember.id, shopper.id]));

await expectReject('a verified phone always says when it was verified',
  () => q(`insert into customer_credentials (customer_id, org_id, password_hash, verified_phone)
           values ($1,$2,'argon2-hash','+12545550123')`, [inStoreMember.id, org.id]),
  'customer_credentials_phone_verified_pair');

// ------------------------------------------------ 18. delivery and online payment
//
// Where an order is going, and the money held for it before it goes. A driver
// needs a ZIP code and a phone number that dial; a webhook needs one delivery
// per courier id; and an order can have one live payment at a time, which is
// what stops a double-clicked checkout holding twice.
const [deliveryOrder] = await orderInsert({ order_number: 'HH01-0917-001', fulfilment: 'delivery' });

const deliveryInsert = (extra = {}) => {
  const row = {
    order_id: deliveryOrder.id, org_id: org.id, provider: 'simulated', recipient_name: 'Dana Ruiz',
    recipient_phone: '+12545550123', address_line1: '100 Example Rd', city: 'Killeen', region: 'TX',
    postal_code: '76542', ...extra,
  };
  const cols = Object.keys(row);
  return q(`insert into order_deliveries (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
           Object.values(row));
};

await expectReject('a delivery needs a real five-digit ZIP code',
  () => deliveryInsert({ postal_code: '7654' }),
  'delivery_postal_code_format');

await expectReject("a driver can only call a phone number that dials",
  () => deliveryInsert({ recipient_phone: '254-555-0123' }),
  'delivery_phone_e164');

await expectReject('a courier cannot be recorded as requested without the id it was booked under',
  () => deliveryInsert({ requested_at: new Date().toISOString() }),
  'delivery_requested_has_id');

await expectOk("a courier's webhook finds its delivery by the id it was booked under, and nothing else", async () => {
  await deliveryInsert({ external_delivery_id: 'snappos-test-1', requested_at: new Date().toISOString() });
  const [found] = await q(`select org_id, order_id from delivery_lookup_order('snappos-test-1')`);
  if (found?.order_id !== deliveryOrder.id || found?.org_id !== org.id) {
    throw new Error(`webhook lookup found ${JSON.stringify(found)}`);
  }
  const missing = await q(`select * from delivery_lookup_order('snappos-unknown')`);
  if (missing.length !== 0) throw new Error('an unknown delivery id resolved to an order');
});

await expectReject('one courier id names one delivery',
  async () => {
    const [second] = await orderInsert({ order_number: 'HH01-0917-002', fulfilment: 'delivery' });
    await q(`insert into order_deliveries (order_id, org_id, provider, recipient_name, recipient_phone, address_line1,
               city, region, postal_code, external_delivery_id)
             values ($1,$2,'simulated','Sam','+12545550199','1 A St','Killeen','TX','76542','snappos-test-1')`,
            [second.id, org.id]);
  },
  'order_deliveries_external_id_key');

await expectReject('a delivery area is a list of five-digit ZIP codes',
  () => q(`insert into store_delivery_settings (store_id, org_id, postal_codes) values ($1,$2,'{76548,7654}')`,
          [store.id, org.id]),
  'delivery_postal_codes_format');

await expectOk('a store delivers to the ZIP codes it lists', () =>
  q(`insert into store_delivery_settings (store_id, org_id, enabled, postal_codes, fee_minor)
     values ($1,$2,true,'{76542,76548}',499)`, [store.id, org.id]));

const paymentInsert = (extra = {}) => {
  const row = {
    org_id: org.id, order_id: deliveryOrder.id, provider: 'test', provider_reference: `test_pay_${Math.random()}`,
    amount_minor: 4328, status: 'authorized', authorized_at: new Date().toISOString(), ...extra,
  };
  const cols = Object.keys(row);
  return q(`insert into order_payments (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
           Object.values(row));
};

await expectReject('a card column holds four digits and nothing more',
  () => paymentInsert({ card_last4: '42x4' }),
  'order_payment_last4_fmt');

await expectReject('a payment taken says when it was taken',
  () => paymentInsert({ status: 'captured' }),
  'order_payment_captured_at');

const [heldPayment] = await paymentInsert();

await expectReject('an order holds money once, however often checkout is pressed',
  () => paymentInsert(),
  'order_payments_live_key');

await expectReject('a record of money held or taken is never deleted',
  () => q(`delete from order_payments where id = $1`, [heldPayment.id]),
  'cannot be deleted');

await expectOk('a product holds stock unless it says it does not, so every existing item still counts', async () => {
  const [row] = await q(`select track_inventory from products where id = $1`, [prod.id]);
  if (row?.track_inventory !== true) throw new Error('an existing product stopped tracking inventory');
});

// ------------------------------------------------ 19. website banners
const bannerInsert = (extra = {}) => {
  const row = {
    org_id: org.id, placement: 'home_hero', title: 'Pulse X', link_kind: 'brand', link_value: brand.id,
    image_key: 'banners/x/wide.jpg', image_width: 1920, image_height: 853, alt_text: 'Geek Bar Pulse X device', ...extra,
  };
  const cols = Object.keys(row);
  return q(`insert into storefront_banners (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
           Object.values(row));
};

await expectReject('a banner over a brand page belongs to a brand',
  () => bannerInsert({ placement: 'brand_header', link_kind: 'category', link_value: 'disposable' }),
  'banner_brand_header_link');

await expectReject('a banner that links somewhere says where',
  () => bannerInsert({ link_kind: 'product', link_value: ' ' }),
  'banner_link_has_value');

await expectReject('a banner describes its picture for people who cannot see it',
  () => bannerInsert({ alt_text: '  ' }),
  'banner_alt_not_blank');

await expectOk('a banner with a picture, a link and a description is saved', () => bannerInsert());

// ------------------------------------------------ 20. price groups
const [lineGroup] = await q(`insert into price_groups (org_id, name, product_id) values ($1,'Geek Bar Pulse X',$2) returning id`,
                            [org.id, prod.id]);
const [promoGroup] = await q(`insert into price_groups (org_id, name) values ($1,'Slow movers') returning id`, [org.id]);
const [otherOrgGroup] = await q(`insert into price_groups (org_id, name) values ($1,'Other') returning id`, [org2.id]);

await expectOk('a flavor can sit in its line group and a promotion at once', async () => {
  await q(`insert into price_group_members (org_id, price_group_id, variant_id) values ($1,$2,$3),($1,$2,$4),($1,$5,$3)`,
          [org.id, lineGroup.id, v1.id, v2.id, promoGroup.id]);
  const [{ n }] = await q(`select count(*)::int n from price_group_members where variant_id = $1`, [v1.id]);
  if (n !== 2) throw new Error(`expected two memberships, got ${n}`);
});

await expectReject('a flavor is in one group once',
  () => q(`insert into price_group_members (org_id, price_group_id, variant_id) values ($1,$2,$3)`, [org.id, promoGroup.id, v1.id]),
  'duplicate key');

await expectReject('a group never holds another organization\'s flavor',
  () => q(`insert into price_group_members (org_id, price_group_id, variant_id) values ($1,$2,$3)`, [org2.id, otherOrgGroup.id, v1.id]),
  'foreign key');

await expectReject('a product has one group made for its flavors, not two',
  () => q(`insert into price_groups (org_id, name, product_id) values ($1,'Geek Bar again',$2)`, [org.id, prod.id]),
  'price_groups_product_key');

await expectOk('deleting a flavor nobody sold takes its group memberships with it', async () => {
  const [v3] = await q(`insert into product_variants (org_id, product_id, sku, variant_name) values ($1,$2,'GB-PX-GRAPE','Grape') returning id`,
                       [org.id, prod.id]);
  await q(`insert into price_group_members (org_id, price_group_id, variant_id) values ($1,$2,$3)`, [org.id, promoGroup.id, v3.id]);
  await q(`delete from product_variants where id = $1`, [v3.id]);
  const [{ n }] = await q(`select count(*)::int n from price_group_members where variant_id = $1`, [v3.id]);
  if (n !== 0) throw new Error('a membership outlived its flavor');
});

await expectOk('deleting a group releases its flavors and nothing else', async () => {
  await q(`delete from price_groups where id = $1`, [promoGroup.id]);
  const [{ members, variants }] = await q(
    `select (select count(*)::int from price_group_members where price_group_id = $1) members,
            (select count(*)::int from product_variants where id = any($2::uuid[])) variants`,
    [promoGroup.id, [v1.id, v2.id]]);
  if (members !== 0) throw new Error('memberships outlived their group');
  if (variants !== 2) throw new Error('deleting a group touched the flavors in it');
});

await scratch.drop();
