#!/usr/bin/env node
/**
 * End to end check against a real server and a real database.
 *
 * Not a substitute for unit tests: this proves the pieces are wired to each
 * other. Permissions actually deny, idempotency actually replays, and stock
 * actually moves through the ledger rather than around it.
 *
 * Requires the dev stack (`npm run db:up`). Resets and re-seeds the database
 * itself, then starts the API on a spare port, so it is a single command and
 * every run begins from the same known state. Asserting that a seeded level is
 * 12 only means something if 12 is what the previous run left behind.
 */

import { spawn, spawnSync } from 'node:child_process';
import { runSalesChecks } from './e2e-sales.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.E2E_PORT ?? 3099);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'dev-password-change-me';

let passed = 0;
let failed = 0;

const check = (name, condition, detail = '') => {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

/** A UUIDv7 with the timestamp in the first 48 bits, as the register mints them. */
function uuidV7() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // Only claim a JSON body when there is one: Fastify rejects a JSON
      // content type with an empty body, which is correct of it.
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ------------------------------------------------- a known database, every run

const cwd = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// A database of its own, never the development one.
//
// This suite drops and recreates whatever it points at. Pointed at `snappos`
// it would also wipe the registers a physical device is provisioned against,
// and that device has no way back: its queued sales reference store, register
// and variant ids that no longer exist, and the roster it unlocks from is
// gone. Running the tests must never cost somebody their till.
const E2E_DB = process.env.E2E_DB_NAME ?? 'snappos_e2e';
const MIGRATOR_URL =
  process.env.E2E_MIGRATOR_URL ??
  `postgres://snappos_migrator:dev_only_not_a_secret@localhost:5432/${E2E_DB}`;
const APP_URL =
  process.env.E2E_DATABASE_URL ??
  `postgres://snappos_app:dev_only_not_a_secret@localhost:5432/${E2E_DB}`;

if (process.env.E2E_SKIP_RESET !== 'true') {
  const reset = spawnSync('npm', ['run', 'db:reset'], {
    cwd: repoRoot,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, DATABASE_URL: MIGRATOR_URL },
  });
  if (reset.status !== 0) {
    console.error('database reset failed', reset.stdout?.toString(), reset.stderr?.toString());
    process.exit(1);
  }
  console.log(`  ${E2E_DB} reset and seeded`);
}

// ------------------------------------------------------------------ the server
// Built and run from its own output directory, never `dist`.
//
// `nest build` empties its target first, so building into `dist` while a
// `nest start --watch` dev server is running from it kills that server: the
// file it is about to reload disappears mid-rebuild. Running the tests must not
// take the development API down with it, for the same reason they must not
// reset the development database.
const server = spawn(process.execPath, ['dist-e2e/main.js'], {
  cwd,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: APP_URL,
    JWT_SECRET: 'e2e_secret_that_is_at_least_thirty_two_chars',
    RATE_LIMIT_MAX: '10000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d.toString()));
server.stderr.on('data', (d) => (serverLog += d.toString()));

const stop = () => server.kill();
process.on('exit', stop);

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  await sleep(500);
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
}

if (!ready) {
  console.error('server did not start\n', serverLog);
  process.exit(1);
}

console.log('\nEND TO END\n');

// ------------------------------------------------------------------- 1. health

{
  const { status, body } = await api('/health');
  check('health responds without a token', status === 200 && body.status === 'ok');

  const readiness = await api('/health/ready');
  check('readiness reports the database', readiness.body?.database === true);
}

// --------------------------------------------------------------------- 2. auth

const unauth = await api('/api/v1/catalog/categories');
check('an unauthenticated request is refused', unauth.status === 401, `got ${unauth.status}`);
check(
  'the error body carries a stable code and a request id',
  unauth.body?.code === 'unauthenticated' && typeof unauth.body?.request_id === 'string',
  JSON.stringify(unauth.body),
);

const badLogin = await api('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'owner@hhsmoke.test', password: 'wrong-password' },
});
check('a wrong password is refused', badLogin.status === 401);

const unknownUser = await api('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'nobody@nowhere.test', password: 'wrong-password' },
});
check(
  'an unknown account answers identically to a wrong password',
  unknownUser.status === badLogin.status && unknownUser.body.code === badLogin.body.code,
);

const owner = await api('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'owner@hhsmoke.test', password: PASSWORD },
});
check('the owner can sign in', owner.status === 201, JSON.stringify(owner.body));
const ownerToken = owner.body?.access_token;

const cashier = await api('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'cashier@hhsmoke.test', password: PASSWORD },
});
const cashierToken = cashier.body?.access_token;
check('the cashier can sign in', cashier.status === 201);

const manager = await api('/api/v1/auth/login', {
  method: 'POST',
  body: { email: 'manager@hhsmoke.test', password: PASSWORD },
});
const managerToken = manager.body?.access_token;
check('the manager can sign in', manager.status === 201);

// --------------------------------------------------------- 3. refresh rotation

{
  const first = await api('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: owner.body.refresh_token },
  });
  check('a refresh token can be exchanged once', first.status === 201);

  const replay = await api('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: owner.body.refresh_token },
  });
  check('replaying a spent refresh token is refused', replay.status === 401, `got ${replay.status}`);

  const afterRevoke = await api('/api/v1/auth/refresh', {
    method: 'POST',
    body: { refresh_token: first.body.refresh_token },
  });
  check(
    'reuse revokes the whole family, so the newest token dies too',
    afterRevoke.status === 401,
    `got ${afterRevoke.status}`,
  );
}

// --------------------------------------------------------------- 4. permissions

const categories = await api('/api/v1/catalog/categories', { token: ownerToken });
check('the owner can read the catalog', categories.status === 200, JSON.stringify(categories.body));

{
  const forbidden = await api('/api/v1/inventory/movements', {
    token: cashierToken,
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      movements: [
        { store_id: randomUUID(), variant_id: randomUUID(), delta: '1', reason: 'receiving' },
      ],
    },
  });
  check(
    'a cashier cannot adjust inventory',
    forbidden.status === 403 && forbidden.body.code === 'forbidden',
    `got ${forbidden.status} ${JSON.stringify(forbidden.body)}`,
  );
}

// ------------------------------------------------------------------- 5. catalog

const storesResponse = await api('/api/v1/stores', { token: ownerToken });
check('a register can discover its store', storesResponse.status === 200);
const storeId = storesResponse.body?.data?.[0]?.id;

const scan = await api(`/api/v1/catalog/scan/840216300101?store_id=${storeId}`, {
  token: cashierToken,
});
check(
  'a cashier can scan a barcode',
  scan.status === 200 && scan.body.sku === 'GB-PULSEX-MM',
  JSON.stringify(scan.body),
);
check(
  'one scan returns price, stock and the age rule together',
  scan.body?.price_minor === '2499' &&
    scan.body?.minimum_age === 21 &&
    scan.body?.id_scan_required === true,
  JSON.stringify(scan.body),
);

const unknownScan = await api(`/api/v1/catalog/scan/000000000000?store_id=${storeId}`, {
  token: cashierToken,
});
check('an unknown barcode is a clean 404', unknownScan.status === 404);

const search = await api(`/api/v1/catalog/products?q=geek&store_id=${storeId}`, {
  token: ownerToken,
});
check(
  'search finds all four Geek Bar flavors',
  search.body?.data?.length === 4,
  `found ${search.body?.data?.length}`,
);

const inStock = await api(`/api/v1/catalog/products?q=geek&store_id=${storeId}&in_stock=true`, {
  token: ownerToken,
});
check(
  'the out of stock flavor is excluded when in_stock is requested',
  inStock.body?.data?.length === 3,
  `found ${inStock.body?.data?.length}`,
);

// ----------------------------------------------------------------- 6. inventory

const variantId = scan.body.variant_id;

const before = await api(
  `/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`,
  { token: ownerToken },
);
const onHandBefore = Number(before.body?.[0]?.on_hand ?? 0);
check('the seeded level is readable', onHandBefore === 12, `on_hand ${onHandBefore}`);

const receiveKey = randomUUID();
const receive = {
  movements: [
    {
      store_id: storeId,
      variant_id: variantId,
      delta: '10',
      reason: 'receiving',
      unit_cost: '9.850000',
    },
  ],
};

const firstPost = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  headers: { 'idempotency-key': receiveKey },
  body: receive,
});
check('receiving stock succeeds', firstPost.status === 201, JSON.stringify(firstPost.body));

const replayPost = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  headers: { 'idempotency-key': receiveKey },
  body: receive,
});
check('replaying the identical request is accepted', replayPost.status === 201);

const after = await api(
  `/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`,
  { token: ownerToken },
);
const onHandAfter = Number(after.body?.[0]?.on_hand ?? 0);
check(
  'a replayed receive moves stock once, not twice',
  onHandAfter === onHandBefore + 10,
  `expected ${onHandBefore + 10}, got ${onHandAfter}`,
);

const reused = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  headers: { 'idempotency-key': receiveKey },
  body: {
    movements: [{ store_id: storeId, variant_id: variantId, delta: '99', reason: 'receiving' }],
  },
});
check(
  'the same key with a different body is a 409, not a silent drop',
  reused.status === 409 && reused.body.code === 'idempotency_key_reuse',
  `got ${reused.status} ${JSON.stringify(reused.body)}`,
);

const noKey = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  body: receive,
});
check('a stock write without an Idempotency-Key is refused', noKey.status === 400);

const zeroDelta = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  headers: { 'idempotency-key': randomUUID() },
  body: {
    movements: [{ store_id: storeId, variant_id: variantId, delta: '0', reason: 'receiving' }],
  },
});
check(
  'a zero movement is refused with field level detail',
  zeroDelta.status === 400 && Array.isArray(zeroDelta.body.issues),
  JSON.stringify(zeroDelta.body),
);

const noNote = await api('/api/v1/inventory/movements', {
  token: ownerToken,
  method: 'POST',
  headers: { 'idempotency-key': randomUUID() },
  body: {
    movements: [{ store_id: storeId, variant_id: variantId, delta: '-1', reason: 'theft' }],
  },
});
check('shrinkage without a note is refused', noNote.status === 400);

const reconcile = await api(`/api/v1/inventory/reconcile?store_id=${storeId}`, {
  token: ownerToken,
});
check(
  'every level still equals the sum of its ledger',
  reconcile.body?.healthy === true,
  JSON.stringify(reconcile.body?.drift),
);

// ---------------------------------------------------------------------- 7. sync

{
  const changes = await api('/api/v1/sync/changes?since=0&limit=10', { token: cashierToken });
  check('a register can pull changes', changes.status === 200, JSON.stringify(changes.body));
  check(
    'an empty page leaves the cursor where it was rather than skipping ahead',
    changes.body?.next_cursor === '0' || changes.body?.changes?.length > 0,
    JSON.stringify(changes.body),
  );

  // The feed has to actually report things. Until migration 0008 nothing wrote
  // to change_log, so this endpoint answered "nothing changed" forever and a
  // register had no way to learn about a price change except to pull the whole
  // catalog again.
  check(
    'the seed produced changes to report',
    changes.body?.changes?.length > 0,
    `${changes.body?.changes?.length} changes, cursor ${changes.body?.next_cursor}`,
  );
  check(
    'a change names what changed and carries a hash',
    changes.body?.changes?.every(
      (c) => c.entity_type && c.entity_id && c.op && c.scope && c.payload_hash,
    ),
    JSON.stringify(changes.body?.changes?.[0]),
  );

  // Paging: a page smaller than the backlog reports more to come, and the
  // cursor it hands back is where the next page starts.
  check(
    'a partial page says there is more',
    changes.body?.has_more === true,
    JSON.stringify({ n: changes.body?.changes?.length, more: changes.body?.has_more }),
  );

  // The cursor is held below any change whose transaction might still be in
  // flight, and that is the single most important property of this feed.
  //
  // A bigserial is allocated before its transaction commits, so row 500 can
  // become visible after row 501. A reader that consumed up to max(id) would
  // skip row 500 permanently — a price change or a new product that no register
  // ever hears about, with nothing anywhere reporting a problem. The watermark
  // trades re-delivery for that: the same change may arrive twice, which is
  // harmless because applying it is idempotent, and none is ever missed.
  //
  // So this asserts the cursor never runs ahead of what was delivered. It
  // deliberately does *not* assert that resuming returns nothing: immediately
  // after a reset every row still looks recent, and the conservative answer is
  // the correct one.
  const drained = await api('/api/v1/sync/changes?since=0&limit=1000', {
    token: cashierToken,
  });
  const ids = (drained.body?.changes ?? []).map((c) => Number(c.id));
  check(
    'changes arrive in cursor order',
    ids.every((id, i) => i === 0 || id > ids[i - 1]),
    `n=${ids.length} ${JSON.stringify(ids.slice(0, 12))}`,
  );
  check(
    'the cursor is never handed out past a change that might still be in flight',
    ids.length > 0 && Number(drained.body?.next_cursor) <= Math.max(...ids),
    `cursor ${drained.body?.next_cursor}, highest delivered ${Math.max(...ids)}`,
  );

  const scoped = await api('/api/v1/sync/changes?since=0&scopes=prices&limit=50', {
    token: cashierToken,
  });
  check(
    'a register can ask for one scope and gets only that scope',
    scoped.body?.changes?.length > 0 &&
      scoped.body.changes.every((c) => c.scope === 'prices'),
    JSON.stringify(scoped.body?.changes?.map((c) => c.scope)),
  );

  // Signing in writes users.last_login_at. Without the ignored-column rule that
  // would mark the whole employees scope dirty on the most frequent write in
  // the system — every register refetching its roster because somebody logged
  // in, on the very feed that exists to avoid pointless refetching.
  const beforeLogin = await api('/api/v1/sync/changes?since=0&limit=1000', {
    token: cashierToken,
  });
  await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email: 'cashier@hhsmoke.test', password: PASSWORD },
  });
  const afterLogin = await api('/api/v1/sync/changes?since=0&limit=1000', {
    token: cashierToken,
  });
  check(
    'signing in does not report a change',
    afterLogin.body?.next_cursor === beforeLogin.body?.next_cursor,
    `cursor ${beforeLogin.body?.next_cursor} -> ${afterLogin.body?.next_cursor}`,
  );

  const registers = await api('/api/v1/registers', { token: ownerToken });
  const registerId = registers.body?.data?.[0]?.id;

  // A register generated UUIDv7. Its embedded timestamp pins the ledger
  // partition, which is what makes the replay below conflict rather than
  // inserting a second movement.
  const envelope = {
    register_id: registerId,
    device_id: randomUUID(),
    entities: [
      {
        id: uuidV7(),
        entity_type: 'inventory_movement',
        device_time: new Date().toISOString(),
        payload: {
          store_id: storeId,
          variant_id: variantId,
          delta: '-1',
          reason: 'damage',
          note: 'dropped at the counter',
        },
      },
    ],
  };

  // A cashier may upload sales but not stock adjustments. The entity level
  // check means the sync route cannot be used to get around that.
  const cashierAttempt = await api('/api/v1/sync/batch', {
    token: cashierToken,
    method: 'POST',
    body: envelope,
  });
  check(
    'a cashier cannot push a stock adjustment through sync',
    cashierAttempt.body?.results?.[0]?.error?.code === 'forbidden',
    JSON.stringify(cashierAttempt.body?.results?.[0]),
  );

  const upload = await api('/api/v1/sync/batch', {
    token: ownerToken,
    method: 'POST',
    body: envelope,
  });
  check(
    'a register upload is accepted',
    upload.body?.results?.[0]?.status === 'accepted',
    JSON.stringify(upload.body),
  );

  const replay = await api('/api/v1/sync/batch', {
    token: ownerToken,
    method: 'POST',
    body: envelope,
  });
  check(
    'the same upload delivered twice reports duplicate, not an error',
    replay.body?.results?.[0]?.status === 'duplicate',
    JSON.stringify(replay.body),
  );

  const levels = await api(
    `/api/v1/inventory/levels?store_id=${storeId}&variant_ids=${variantId}`,
    { token: ownerToken },
  );
  check(
    'a duplicated upload moved stock exactly once',
    Number(levels.body?.[0]?.on_hand) === onHandAfter - 1,
    `expected ${onHandAfter - 1}, got ${levels.body?.[0]?.on_hand}`,
  );

  const stillHealthy = await api(`/api/v1/inventory/reconcile?store_id=${storeId}`, {
    token: ownerToken,
  });
  check('the ledger and levels still agree after sync', stillHealthy.body?.healthy === true);
}

// --------------------------------------------------- 8. a day at the counter

await runSalesChecks({
  api,
  check,
  uuidV7,
  ownerToken,
  managerToken,
  cashierToken,
  storeId,
});

// ------------------------------------------------------------------ 9. summary

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('--- server log (tail) ---');
  console.log(serverLog.split('\n').slice(-30).join('\n'));
}
stop();
process.exit(failed > 0 ? 1 : 0);
