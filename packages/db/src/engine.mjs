// Engine abstraction for migrations, seeds and tests.
//
// The same migration files must apply to two engines:
//   * PGlite   - Postgres compiled to WebAssembly. No daemon, starts in ~200ms,
//                runs everything as a single superuser. Used for the fast suite.
//   * Postgres - the real thing, via Docker. The only engine that can prove RLS
//                works, because RLS is a no-op for a table owner and PGlite has
//                no way to connect as a non-owner.
//
// Tests that require a genuine privilege separation declare `requires: 'postgres'`
// and are skipped with a visible notice under PGlite rather than passing quietly.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Migration files in dependency order. The numeric prefix is the order. */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

export const DEFAULT_URL =
  process.env.DATABASE_URL ??
  'postgres://snappos_migrator:dev_only_not_a_secret@localhost:5432/snappos';

/**
 * Open a connection.
 * @param {{engine?: 'pglite'|'postgres', url?: string, database?: string}} opts
 * @returns {Promise<{engine: string, query: Function, exec: Function, close: Function}>}
 */
export async function connect(opts = {}) {
  const engine = opts.engine ?? process.env.SNAPPOS_TEST_ENGINE ?? 'pglite';

  if (engine === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;
    return {
      engine: 'pglite',
      query: async (sql, params) => (await db.query(sql, params)).rows,
      exec: async (sql) => { await db.exec(sql); },
      close: async () => { await db.close(); },
    };
  }

  if (engine === 'postgres') {
    const pg = await import('pg');
    const url = opts.url ?? DEFAULT_URL;
    const client = new pg.default.Client({ connectionString: url });
    await client.connect();
    return {
      engine: 'postgres',
      url,
      query: async (sql, params) => (await client.query(sql, params)).rows,
      // Multi statement SQL goes through the simple query protocol, which is
      // what lets a whole migration file run as one call.
      exec: async (sql) => { await client.query(sql); },
      close: async () => { await client.end(); },
    };
  }

  throw new Error(`unknown engine: ${engine}`);
}

/** Apply every migration in order. Used by tests against a throwaway database. */
export async function applyMigrations(db) {
  for (const { name, sql } of migrationFiles()) {
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`migration ${name} failed: ${e.message}`);
    }
  }
}

/**
 * A disposable database. On PGlite that is simply a fresh in-memory instance.
 * On Postgres it is a real CREATE DATABASE, dropped afterwards, so a test run
 * never touches the development data.
 */
export async function createScratchDatabase(engine = process.env.SNAPPOS_TEST_ENGINE ?? 'pglite') {
  if (engine === 'pglite') {
    const db = await connect({ engine: 'pglite' });
    await applyMigrations(db);
    return { db, engine, drop: () => db.close() };
  }

  const pg = await import('pg');
  const name = `snappos_test_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.default.Client({ connectionString: DEFAULT_URL });
  await admin.connect();

  // Sweep scratch databases left behind by a crashed run. Without this they
  // accumulate silently and a developer finds forty of them in six months.
  // Anything older than an hour cannot belong to a run still in progress.
  const stale = await admin.query(
    `SELECT datname FROM pg_database
     WHERE datname LIKE 'snappos_test\_%' ESCAPE '\'
       AND (pg_stat_file('base/' || oid::text, true)).modification < now() - interval '1 hour'`,
  );
  for (const row of stale.rows) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    } catch {
      // Another runner may have claimed it first. Not worth failing a test over.
    }
  }

  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = DEFAULT_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const db = await connect({ engine: 'postgres', url });
  await applyMigrations(db);
  // Grants live per database, so a scratch database needs them too or the RLS
  // suite cannot connect as snappos_app.
  await db.exec(readFileSync(path.join(MIGRATIONS_DIR, '..', 'scripts', 'bootstrap-roles.sql'), 'utf8'));

  return {
    db,
    engine,
    name,
    url,
    drop: async () => {
      await db.close();
      const a = new pg.default.Client({ connectionString: DEFAULT_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
