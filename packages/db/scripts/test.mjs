#!/usr/bin/env node
// Cross platform test runner.
//
// npm runs scripts through cmd.exe on Windows, where `VAR=value cmd` is not
// valid syntax and `test/` is not expanded into a file list. Both work on a
// POSIX shell, which is exactly the kind of difference that makes CI green and
// a developer's machine red. This runner takes the shell out of the equation.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const engine = process.argv.includes('--postgres') ? 'postgres' : 'pglite';

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(testDir, f));

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

console.log(`\n  engine: ${engine}   files: ${files.length}\n`);

// Postgres test files share one server and each one bootstraps roles and grants.
// CREATE ROLE, ALTER ROLE and GRANT ... ON DATABASE write cluster wide catalogs,
// so running the files in parallel produces "tuple concurrently updated" at
// random points. PGlite instances are in memory and fully isolated, so they
// keep the default parallelism.
const concurrency = engine === 'postgres' ? ['--test-concurrency=1'] : [];

const result = spawnSync(process.execPath, ['--test', ...concurrency, ...files], {
  stdio: 'inherit',
  env: { ...process.env, SNAPPOS_TEST_ENGINE: engine },
});

process.exit(result.status ?? 1);
