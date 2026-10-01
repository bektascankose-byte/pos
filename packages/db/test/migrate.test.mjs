// Proves every migration applies cleanly and that the resulting schema is the
// shape we think it is. Runs on PGlite by default, on real Postgres with
// SNAPPOS_TEST_ENGINE=postgres.
//
// A note on what is asserted and what is not. Counts of tables, foreign keys,
// enums, functions and triggers are stable facts about the migrations. Counts
// that include partitions are NOT: ensure_monthly_partitions() creates
// partitions relative to now(), so those totals change with the calendar. An
// earlier revision of the README quoted a partition inclusive number and it has
// already drifted. Only stable numbers are asserted here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createScratchDatabase, migrationFiles } from '../src/engine.mjs';

const scratch = await createScratchDatabase();
const db = scratch.db;
const n = async (sql) => Number((await db.query(sql))[0].n);

test(`all ${migrationFiles().length} migrations applied on ${scratch.engine}`, () => {
  assert.equal(migrationFiles().length, 36);
});

test('migrations are numbered contiguously from 0001', () => {
  const prefixes = migrationFiles().map((f) => Number(f.name.slice(0, 4)));
  assert.deepEqual(prefixes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
});

// 0034 adds two: pos_catalog_variants (what the registers were last sent) and
// pos_releases (each press of Send). 0035 adds price_group_members, so a
// flavor can sit in more than one price group. 0036 adds
// password_reset_tokens.
test('102 base tables exist', async () => {
  assert.equal(
    await n(`select count(*) n from pg_class c
             join pg_namespace ns on ns.oid = c.relnamespace
             where ns.nspname='public' and c.relkind in ('r','p')
               and not c.relispartition`),
    102,
  );
});

test('inventory_ledger and audit_log are range partitioned', async () => {
  const rows = await db.query(
    `select c.relname from pg_class c
     join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname='public' and c.relkind='p' order by c.relname`,
  );
  assert.deepEqual(rows.map((r) => r.relname), ['audit_log', 'inventory_ledger']);
});

test('161 foreign keys, 35 enums, 143 table level checks', async () => {
  // 0027 accounts for the last move: seven foreign keys (four off `orders`,
  // two off `order_lines`, one off `order_events`), the order_fulfilment and
  // order_status enums, and six checks -- four on `orders` including the one
  // that makes "completed" and "has a sale" the same fact, two on
  // `order_lines`. 0028 then adds ten foreign keys (shop keys, customer
  // credentials, sessions and one-time tokens, carts and their lines), the
  // customer_token_purpose enum, and seven checks -- expiries that must follow
  // their start, a cart line for something, and `orders.placed_via`.
  // 0030 adds the loyalty ledger: three foreign keys (customer, sale, refund),
  // the loyalty_entry_kind enum, six checks on what each kind of entry must
  // carry and one pairing a verified phone with when it was verified. 0031
  // adds delivery: three foreign keys (settings to store, delivery and payment
  // to order), the order_payment_status enum, and thirteen checks -- ZIP codes,
  // fees and a cutoff on the settings, a ZIP, an E.164 phone and a courier id on
  // the delivery, amounts and timestamps on the payment, and a cart's ZIP. 0032
  // adds banners: one foreign key, the banner_placement enum and eight checks.
  // 0033 adds the lifts a shop records against a platform rule: two foreign
  // keys (organization and rule, both RESTRICT so neither can be deleted out
  // from under a record of what was traded under it), no enum, and five checks
  // -- the withdrawal window, a permit reference and an authority note that
  // are actually filled in, a counsel review date that is not in the future,
  // and a withdrawal that names who withdrew it. 0034 adds two foreign keys,
  // both to organizations: the sent catalog deliberately has none to the
  // variants it copies, since a register keeps what it was sent until the next
  // Send even if the variant is deleted meanwhile. 0035 nets two: the
  // membership table's keys to its group and to the variant, and a group's
  // key to the product it was made for, less the variant's old single
  // price_group_id key, dropped with the column. 0036 adds two: a reset token
  // belongs to an organization and to the user whose password it resets.
  assert.equal(await n(`select count(*) n from pg_constraint c
                        join pg_namespace ns on ns.oid=c.connamespace
                        where ns.nspname='public' and c.contype='f'`), 161);
  assert.equal(await n(`select count(distinct t.typname) n from pg_type t
                        join pg_namespace ns on ns.oid=t.typnamespace
                        where ns.nspname='public' and t.typtype='e'`), 35);
  assert.equal(await n(`select count(*) n from pg_constraint c
                        join pg_class t on t.oid=c.conrelid
                        join pg_namespace ns on ns.oid=c.connamespace
                        where ns.nspname='public' and c.contype='c'
                          and not t.relispartition`), 143);
});

test('21 functions and 56 user triggers', async () => {
  // Extensions install their own functions into public (pg_trgm adds ~20), so
  // count only what our migrations own.
  assert.equal(await n(`select count(*) n from pg_proc p
                        join pg_namespace ns on ns.oid=p.pronamespace
                        where ns.nspname='public'
                          and not exists (
                            select 1 from pg_depend d
                            where d.objid = p.oid and d.deptype = 'e')`), 21);
  // 18, plus the twelve change_log triggers from migration 0008 (one per
  // replicated table) plus the one from 0010 on role_permissions (the join
  // table that grants a permission to a role, whose own change_log trigger
  // has to look up the role's org rather than reading org_id off its own row)
  // plus one each from 0011 (shifts), 0012 (loyalty_settings), 0014
  // (invoice_imports), 0015 (onboarding_task_templates) and 0017
  // (import_jobs), two from 0018 (customer_segments, campaigns), one from 0019
  // (receiving_sessions), one from 0020 (reference_products) and one from 0027
  // (orders) -- all reusing touch_updated_at rather than a new function, which
  // is why the function count moves only by the one 0018 actually adds,
  // marketing_unsubscribe -- and by the one 0028 adds, shop_lookup_client, the
  // definer function a storefront key is resolved through, and by the three
  // 0029 adds so the outbox pump can claim and settle events row level security
  // would otherwise hide from it. 0028 also adds three
  // touch triggers: customer_credentials, carts and cart_lines. 0030 adds one
  // function (guard_loyalty_ledger) and two triggers keeping the ledger's
  // history uneditable and undeletable; 0031 adds delivery_lookup_order, the
  // definer function a courier's webhook is matched through, and four triggers
  // (three touch, and one refusing to delete a payment); 0032 adds one touch
  // trigger for banners. 0033 adds guard_compliance_rule_lift, which allows a
  // lift only against a platform rule and only lets a withdrawal be written
  // afterwards, and three triggers: that guard, a touch, and a refusal to
  // delete. 0034 adds the change_log trigger on pos_releases, which is how a
  // press of Send reaches the registers.
  assert.equal(await n(`select count(*) n from pg_trigger where not tgisinternal`), 56);
});

test('every table carrying org_id has RLS enabled and exactly one policy', async () => {
  const unguarded = await db.query(
    `select c.relname from pg_class c
     join pg_namespace ns on ns.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attname='org_id' and a.attnum > 0
     where ns.nspname='public' and c.relkind in ('r','p')
       and not c.relispartition and c.relrowsecurity = false`,
  );
  assert.deepEqual(unguarded.map((r) => r.relname), [], 'tables missing RLS');

  const armed = await n(`select count(*) n from pg_class c
                         join pg_namespace ns on ns.oid=c.relnamespace
                         where ns.nspname='public' and c.relrowsecurity`);
  const policies = await n(`select count(*) n from pg_policies where schemaname='public'`);
  assert.equal(policies, armed, 'every RLS table needs a policy or it denies everything');
});

test('migrations are idempotent enough to detect a double apply', async () => {
  // Re-applying is expected to fail loudly rather than silently duplicate.
  // A migration runner tracks what it applied; the files themselves do not
  // guard, and that is deliberate.
  await assert.rejects(() => db.exec(migrationFiles()[0].sql));
});

// Fuzzy product search needs pg_trgm. 0002 degrades to tsvector only when the
// extension is unavailable rather than failing the migration, which is correct
// for managed hosts that require allowlisting. PGlite does not ship it, so this
// is a real difference between the two engines and is reported, not hidden.
test('pg_trgm backed fuzzy search index', async (t) => {
  const [ext] = await db.query(`select extname from pg_extension where extname='pg_trgm'`);
  if (scratch.engine !== 'postgres') {
    assert.equal(ext, undefined, 'unexpected: PGlite grew pg_trgm, tighten this test');
    t.skip('pg_trgm is not bundled with PGlite; search degrades to tsvector. Verified on Postgres.');
    return;
  }
  assert.equal(ext?.extname, 'pg_trgm');
  const [idx] = await db.query(
    `select indexname from pg_indexes where schemaname='public' and indexname='variant_search_trgm_idx'`,
  );
  assert.equal(idx?.indexname, 'variant_search_trgm_idx', 'trigram index silently skipped');
});

after(async () => { await scratch.drop(); });
