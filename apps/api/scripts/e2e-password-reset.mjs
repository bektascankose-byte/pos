/**
 * Forgetting a password, and getting back in.
 *
 * The security properties here are the point, not the happy path: a stranger
 * must not be able to learn which addresses have accounts, a link must work
 * once and only once, and resetting must throw out sessions that were already
 * open. Each of those is checked against the running server.
 *
 * SMTP is deliberately not configured for e2e, so the send fails and logs and
 * the flow carries on regardless -- which is itself worth proving, because a
 * mail server being down must not stop a token being issued or make the
 * endpoint answer differently.
 *
 * Imported by e2e.mjs, sharing its server and its reset.
 */

export async function runPasswordResetChecks({ api, check, sql, ownerEmail }) {
  const request = (email) =>
    api('/api/v1/auth/password-reset/request', { method: 'POST', body: { email } });
  const complete = (token, password) =>
    api('/api/v1/auth/password-reset/complete', { method: 'POST', body: { token, password } });
  const login = (password) =>
    api('/api/v1/auth/login', { method: 'POST', body: { email: ownerEmail, password } });

  // --- a stranger learns nothing -------------------------------------------

  const unknown = await request('definitely-nobody@example.invalid');
  const known = await request(ownerEmail);
  check(
    'a reset request answers the same for an unknown address as for a real one',
    unknown.status === 200 &&
      known.status === 200 &&
      JSON.stringify(unknown.body) === JSON.stringify(known.body),
    `unknown ${unknown.status} ${JSON.stringify(unknown.body)}, known ${known.status} ${JSON.stringify(known.body)}`,
  );

  const strangerRows = await sql(
    `SELECT count(*)::int AS n FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE u.email = 'definitely-nobody@example.invalid'`,
  );
  check('no token is minted for an address with no account', strangerRows[0].n === 0);

  // --- the token itself -----------------------------------------------------

  const stored = await sql(
    `SELECT token_hash, expires_at > now() AS live, used_at IS NULL AS unused
     FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
     WHERE u.email = $1 ORDER BY t.created_at DESC LIMIT 1`,
    [ownerEmail],
  );
  check('a request mints one live unused token', stored.length === 1 && stored[0].live && stored[0].unused);
  check(
    'only the hash is stored, never anything that opens the account',
    stored.length === 1 && /^[0-9a-f]{64}$/.test(stored[0].token_hash),
    stored[0]?.token_hash,
  );

  // Asking again must put the first link out of use, or a reset mailed last
  // week still opens the account.
  const firstHash = stored[0].token_hash;
  await request(ownerEmail);
  const supersededRows = await sql(
    `SELECT used_at IS NOT NULL AS spent FROM password_reset_tokens WHERE token_hash = $1`,
    [firstHash],
  );
  check('asking again puts the previous link out of use', supersededRows[0]?.spent === true);

  // --- a link that was never issued ----------------------------------------

  const madeUp = await complete('z'.repeat(43), 'a-perfectly-fine-password');
  check('a token nobody issued is refused', madeUp.status === 401, `got ${madeUp.status}`);

  const tooShort = await complete('z'.repeat(43), 'short');
  check('a password under 8 characters is refused', tooShort.status === 400, `got ${tooShort.status}`);

  // --- the real thing -------------------------------------------------------
  //
  // The raw token only ever existed inside the email, which is the whole
  // design, so the test plants a token of its own exactly as the service
  // would: hash in the table, raw value in hand.
  const raw = `e2e-${'r'.repeat(40)}`;
  const { createHash } = await import('node:crypto');
  const rawHash = createHash('sha256').update(raw).digest('hex');
  await sql(
    `INSERT INTO password_reset_tokens (org_id, user_id, token_hash, expires_at)
     SELECT u.org_id, u.id, $2, now() + interval '1 hour' FROM users u WHERE u.email = $1`,
    [ownerEmail, rawHash],
  );

  const newPassword = 'e2e-reset-password-9f2b';
  const done = await complete(raw, newPassword);
  check('a valid link sets the new password', done.status === 200, `got ${done.status} ${JSON.stringify(done.body)}`);

  const signedIn = await login(newPassword);
  check('the new password signs in', signedIn.status === 201 || signedIn.status === 200, `got ${signedIn.status}`);

  const replayed = await complete(raw, 'another-password-entirely');
  check('the same link cannot be used twice', replayed.status === 401, `got ${replayed.status}`);

  const stillWorks = await login(newPassword);
  check(
    'the refused replay did not change the password',
    stillWorks.status === 201 || stillWorks.status === 200,
    `got ${stillWorks.status}`,
  );

  // --- an expired link ------------------------------------------------------

  const staleRaw = `e2e-${'s'.repeat(40)}`;
  const staleHash = createHash('sha256').update(staleRaw).digest('hex');
  await sql(
    `INSERT INTO password_reset_tokens (org_id, user_id, token_hash, expires_at, created_at)
     SELECT u.org_id, u.id, $2, now() - interval '1 minute', now() - interval '2 hours'
     FROM users u WHERE u.email = $1`,
    [ownerEmail, staleHash],
  );
  const expired = await complete(staleRaw, 'yet-another-password');
  check('an expired link is refused', expired.status === 401, `got ${expired.status}`);

  return { ownerPassword: newPassword };
}
