#!/usr/bin/env node
/**
 * The development API, with the local stack's settings filled in.
 *
 * The API reads `process.env` directly and refuses to boot without a database,
 * a signing secret and object storage, so starting it by hand meant retyping
 * all of them. Every value below is a local-only default already published in
 * `.env.example` and `infra/docker/docker-compose.dev.yml`.
 *
 * Anything already set in the environment wins. That is deliberate: it is how a
 * real key such as OPENAI_API_KEY reaches the server without ever being
 * written into this repository.
 */

import { spawn } from 'node:child_process';

const localDefaults = {
  DATABASE_URL: 'postgres://snappos_app:dev_only_not_a_secret@localhost:5432/snappos',
  JWT_SECRET: 'dev_secret_that_is_at_least_thirty_two_chars',
  PORT: '3000',
  RATE_LIMIT_MAX: '10000',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'snappos-invoices',
  S3_ACCESS_KEY_ID: 'snappos',
  S3_SECRET_ACCESS_KEY: 'dev_only_not_a_secret',
  S3_FORCE_PATH_STYLE: 'true',
  // The model development has been run against. A name, not a credential:
  // the key itself only ever comes from the environment.
  OPENAI_MODEL: 'gpt-5.6-terra',
};

const cwd = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// One command string rather than an argument list: npm is npm.cmd on Windows,
// which only a shell can run, and Node warns about pairing a shell with
// separately passed arguments it would have to concatenate unescaped.
const child = spawn('npm run dev', {
  cwd,
  env: { ...localDefaults, ...process.env },
  stdio: 'inherit',
  shell: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
