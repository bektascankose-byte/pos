#!/usr/bin/env node
// Applies pending migrations to DATABASE_URL, tracked in schema_migrations.
//
// Connects as snappos_migrator (the table owner). The API never uses this role.
// Each file runs inside its own transaction, so a failure leaves the database on
// the last known good migration rather than half applied.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { migrationFiles, DEFAULT_URL, MIGRATIONS_DIR } from '../src/engine.mjs';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : DEFAULT_URL;

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);

const applied = new Map(
  (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [
    r.name,
    r.checksum,
  ]),
);

let ran = 0;
for (const { name, sql } of migrationFiles()) {
  const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const previous = applied.get(name);

  if (previous) {
    // A changed file that has already run is a mistake worth stopping for:
    // the database and the repository now disagree about what the schema is.
    if (previous !== checksum) {
      console.error(
        `\n  ${name} has already been applied but its contents changed.\n` +
          `  applied: ${previous}   now: ${checksum}\n` +
          `  Write a new migration instead of editing an applied one.\n`,
      );
      process.exitCode = 1;
      break;
    }
    continue;
  }

  process.stdout.write(`  applying ${name} ... `);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      name,
      checksum,
    ]);
    await client.query('COMMIT');
    console.log('ok');
    ran++;
  } catch (e) {
    await client.query('ROLLBACK');
    console.log('FAILED');
    console.error(`\n  ${name}: ${e.message}\n`);
    process.exitCode = 1;
    break;
  }
}

// Grants must be re-applied after new tables appear. Default privileges cover
// future migrations, but the first run creates tables before the role exists.
if (ran > 0 && process.exitCode !== 1) {
  const roles = readFileSync(path.join(MIGRATIONS_DIR, '..', 'scripts', 'bootstrap-roles.sql'), 'utf8');
  try {
    await client.query(roles);
    console.log('  grants refreshed for snappos_app');
  } catch (e) {
    console.warn(`  could not refresh grants: ${e.message}`);
  }
}

console.log(ran === 0 ? '\n  nothing to apply, schema is current\n' : `\n  ${ran} applied\n`);
await client.end();
