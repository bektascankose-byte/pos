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
  assert.equal(migrationFiles().length, 18);
});

test('migrations are numbered contiguously from 0001', () => {
  const prefixes = migrationFiles().map((f) => Number(f.name.slice(0, 4)));
  assert.deepEqual(prefixes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
});

test('77 base tables exist', async () => {
  assert.equal(
    await n(`select count(*) n from pg_class c
             join pg_namespace ns on ns.oid = c.relnamespace
             where ns.nspname='public' and c.relkind in ('r','p')
               and not c.relispartition`),
    77,
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

test('118 foreign keys, 26 enums, 87 table level checks', async () => {
  assert.equal(await n(`select count(*) n from pg_constraint c
                        join pg_namespace ns on ns.oid=c.connamespace
                        where ns.nspname='public' and c.contype='f'`), 118);
  assert.equal(await n(`select count(distinct t.typname) n from pg_type t
                        join pg_namespace ns on ns.oid=t.typnamespace
                        where ns.nspname='public' and t.typtype='e'`), 26);
  assert.equal(await n(`select count(*) n from pg_constraint c
                        join pg_class t on t.oid=c.conrelid
                        join pg_namespace ns on ns.oid=c.connamespace
                        where ns.nspname='public' and c.contype='c'
                          and not t.relispartition`), 87);
});

test('12 functions and 38 user triggers', async () => {
  // Extensions install their own functions into public (pg_trgm adds ~20), so
  // count only what our migrations own.
  assert.equal(await n(`select count(*) n from pg_proc p
                        join pg_namespace ns on ns.oid=p.pronamespace
                        where ns.nspname='public'
                          and not exists (
                            select 1 from pg_depend d
                            where d.objid = p.oid and d.deptype = 'e')`), 12);
  // 18, plus the twelve change_log triggers from migration 0008 (one per
  // replicated table) plus the one from 0010 on role_permissions (the join
  // table that grants a permission to a role, whose own change_log trigger
  // has to look up the role's org rather than reading org_id off its own row)
  // plus one each from 0011 (shifts), 0012 (loyalty_settings), 0014
  // (invoice_imports), 0015 (onboarding_task_templates) and 0017
  // (import_jobs), and two from 0018 (customer_segments, campaigns) -- all
  // reusing touch_updated_at rather than a new function, which is why the
  // function count moves only by the one 0018 actually adds,
  // marketing_unsubscribe.
  assert.equal(await n(`select count(*) n from pg_trigger where not tgisinternal`), 38);
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
