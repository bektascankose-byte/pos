// Row level security, proven against a NON-OWNER role.
//
// This suite exists because RLS is a no-op for a table owner. Every policy in
// 0005_rls.sql is invisible to snappos_migrator, so a test that connects as the
// migrator proves nothing at all. These tests connect as snappos_app, which is
// how the API connects in production.
//
// PGlite runs everything as one superuser and has no way to create a second
// login role, so this suite cannot run there. It skips loudly rather than
// reporting a pass it did not earn.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createScratchDatabase } from '../src/engine.mjs';

const engine = process.env.SNAPPOS_TEST_ENGINE ?? 'pglite';

if (engine !== 'postgres') {
  test('row level security (requires real Postgres)', (t) => {
    t.skip(
      'RLS is a no-op for a table owner and PGlite has only one superuser role. ' +
        'Run: docker compose up -d && npm run test:pg',
    );
  });
} else {
  const scratch = await createScratchDatabase('postgres');
  const asMigrator = scratch.db;

  // Two organizations, each with one store. org A must never see org B.
  const [orgA] = await asMigrator.query(
    `insert into organizations (slug, legal_name, display_name)
     values ('org-a','A LLC','A') returning id`,
  );
  const [orgB] = await asMigrator.query(
    `insert into organizations (slug, legal_name, display_name)
     values ('org-b','B LLC','B') returning id`,
  );
  await asMigrator.query(`insert into stores (org_id, code, name) values ($1,'A1','A Store')`, [orgA.id]);
  await asMigrator.query(`insert into stores (org_id, code, name) values ($1,'B1','B Store')`, [orgB.id]);

  const appUrl = scratch.url.replace(
    /\/\/[^@]+@/,
    '//snappos_app:dev_only_not_a_secret@',
  );
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();

  after(async () => {
    await app.end();
    await scratch.drop();
  });

  test('snappos_app is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await app.query(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       from pg_roles where rolname = current_user`,
    );
    assert.deepEqual(rows[0], {
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  test('snappos_app does not own the tables (ownership would void every policy)', async () => {
    const { rows } = await app.query(
      `select count(*)::int n from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname='public' and c.relkind='r' and c.relowner = current_user::regrole`,
    );
    assert.equal(rows[0].n, 0);
  });

  test('with app.org_id unset, a tenant table returns nothing: fail closed', async () => {
    const { rows } = await app.query('select * from stores');
    assert.equal(rows.length, 0, 'an unset org context must deny, never leak');
  });

  test('with app.org_id set, only that org is visible', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.org_id = '${orgA.id}'`);
    const { rows } = await app.query('select code, org_id from stores');
    await app.query('COMMIT');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, 'A1');
    assert.equal(rows[0].org_id, orgA.id);
  });

  test('org A cannot see org B by naming it explicitly', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.org_id = '${orgA.id}'`);
    const { rows } = await app.query('select * from stores where org_id = $1', [orgB.id]);
    await app.query('COMMIT');
    assert.equal(rows.length, 0, 'a WHERE clause must not be able to reach across tenants');
  });

  test('org context does not survive the transaction that set it', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.org_id = '${orgA.id}'`);
    await app.query('COMMIT');
    const { rows } = await app.query('select * from stores');
    assert.equal(rows.length, 0, 'SET LOCAL must not leak into the next request on a pooled connection');
  });

  test('an insert into another org is rejected by the policy', async () => {
    await app.query('BEGIN');
    await app.query(`SET LOCAL app.org_id = '${orgA.id}'`);
    await assert.rejects(
      () => app.query(`insert into stores (org_id, code, name) values ($1,'X9','Smuggled')`, [orgB.id]),
      /row-level security|policy/i,
    );
    await app.query('ROLLBACK');
  });

  test('snappos_app cannot escalate to the owner role', async () => {
    await assert.rejects(() => app.query('SET ROLE snappos_migrator'), /permission denied|not a member/i);
  });

  test('snappos_app cannot drop or truncate a financial table', async () => {
    await assert.rejects(() => app.query('DROP TABLE sales'), /must be owner|permission denied/i);
    await assert.rejects(() => app.query('TRUNCATE sales'), /must be owner|permission denied/i);
  });
}
