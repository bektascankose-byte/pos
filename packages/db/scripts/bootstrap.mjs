#!/usr/bin/env node
// Applies scripts/bootstrap-roles.sql: creates snappos_app and grants it DML only.
// Run once per database, before the first migration. Idempotent.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DEFAULT_URL } from '../src/engine.mjs';

const sql = readFileSync(new URL('./bootstrap-roles.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_URL });
await client.connect();
await client.query(sql);
await client.end();
console.log('  snappos_app role ready (DML only, no BYPASSRLS)');
