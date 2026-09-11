#!/usr/bin/env node
// Drops and recreates the development database, then migrates and seeds.
//
// Refuses to touch anything that does not look like a development database.
// This is the script most likely to be run half awake, so the guard is loud.

import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { DEFAULT_URL } from '../src/engine.mjs';

const url = process.env.DATABASE_URL ?? DEFAULT_URL;
const name = new URL(url).pathname.slice(1);

if (!/localhost|127\.0\.0\.1/.test(url) && !process.argv.includes('--i-mean-it')) {
  console.error(`\n  refusing: ${url.replace(/:[^:@]+@/, ':***@')} is not localhost.\n`);
  process.exit(1);
}

const admin = new pg.Client({ connectionString: url.replace(/\/[^/?]+(\?|$)/, '/postgres$1') });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
console.log(`  recreated ${name}`);

const run = (args) => {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
run([`${here}bootstrap.mjs`]);
run([`${here}migrate.mjs`]);
run([`${here}seed.mjs`]);
