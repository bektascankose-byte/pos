-- =============================================================================
-- 0036_password_reset.sql
--
-- FORGOT PASSWORD. Until now the only way back into the back office after
-- forgetting a password was someone with database access rewriting the hash by
-- hand. That happened twice in a fortnight, and both times the new password
-- had to be spoken aloud to its owner, which is the part worth removing: a
-- password nobody else has ever seen is the whole point of hashing it.
--
-- So a reset is a one time token mailed to the address on the account. The
-- shape follows `auth_lookup_user` in migration 0007, for the same reason it
-- exists: a person asking to reset types an email and nothing else, so the
-- organization is unknown until the user is found, and row level security
-- denies everything while `app.org_id` is unset. Rather than weaken that
-- policy, the two unauthenticated steps go through SECURITY DEFINER functions
-- with fixed column lists.
--
-- Only the SHA-256 of the token is stored. The raw value exists in the email
-- and in the reset link and nowhere else, so a database dump, a query log or a
-- statement sample cannot be turned into a working reset.
-- =============================================================================

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Unique so a hash collision or a replayed insert cannot create two live
  -- tokens that both open the same account.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- Set the moment a token is spent. Single use: a reset link sitting in an
  -- inbox forever is a standing key to the account.
  used_at    timestamptz,
  -- Who asked. Kept for the case where resets start arriving unrequested.
  requested_ip   text,
  requested_from text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reset_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_tokens_user_idx
  ON password_reset_tokens (user_id, created_at DESC);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON password_reset_tokens
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Record a reset request for whoever owns this email, and say who it was.
--
-- Returns no row when the address is not on file or the account is not active.
-- The caller answers the requester identically either way: telling a stranger
-- which addresses have accounts is the one thing a forgot password form must
-- never do.
--
-- Any live token for that user is spent first. Asking again should invalidate
-- the previous link rather than leave two keys outstanding.
CREATE OR REPLACE FUNCTION auth_create_password_reset(
  p_email      text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip         text,
  p_user_agent text
)
RETURNS TABLE (
  user_id   uuid,
  org_id    uuid,
  email     text,
  full_name text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- Not named `found`: PL/pgSQL has a built in FOUND, and a variable of that
  -- name shadows it, so the IF below would be testing a record rather than a
  -- boolean.
  v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_user
  FROM users u
  WHERE u.email = lower(btrim(p_email)) AND u.status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE password_reset_tokens t
  SET used_at = now()
  WHERE t.user_id = v_user.id AND t.used_at IS NULL AND t.expires_at > now();

  INSERT INTO password_reset_tokens
    (org_id, user_id, token_hash, expires_at, requested_ip, requested_from)
  VALUES (v_user.org_id, v_user.id, p_token_hash, p_expires_at, p_ip, left(p_user_agent, 256));

  RETURN QUERY SELECT v_user.id, v_user.org_id, v_user.email, v_user.full_name;
END;
$fn$;

-- Spend a reset token and say whose account it opens.
--
-- The check and the spend are one statement, so two requests racing with the
-- same link cannot both come back with a user: `used_at IS NULL` in the WHERE
-- is what makes a token single use under concurrency, not a read followed by a
-- write. Returns no row for a token that is unknown, expired or already spent,
-- and the caller cannot tell those apart.
CREATE OR REPLACE FUNCTION auth_consume_password_reset(p_token_hash text)
RETURNS TABLE (
  user_id uuid,
  org_id  uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE password_reset_tokens
  SET used_at = now()
  WHERE token_hash = p_token_hash
    AND used_at IS NULL
    AND expires_at > now()
  RETURNING password_reset_tokens.user_id, password_reset_tokens.org_id;
$fn$;

-- EXECUTE is revoked from PUBLIC first. A SECURITY DEFINER function is granted
-- to PUBLIC by default, which would make these callable by any future role.
REVOKE EXECUTE ON FUNCTION auth_create_password_reset(text, text, timestamptz, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_consume_password_reset(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth_create_password_reset(text, text, timestamptz, text, text) TO snappos_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth_consume_password_reset(text) TO snappos_app';
  END IF;
END $$;

COMMENT ON FUNCTION auth_create_password_reset(text, text, timestamptz, text, text) IS
  'Cross tenant by necessity: the org is unknown until the user is found. '
  'Returns no row for an unknown address so the caller cannot enumerate.';

COMMENT ON FUNCTION auth_consume_password_reset(text) IS
  'Cross tenant by necessity: a reset link carries no org. Checks and spends '
  'in one statement, so a token cannot be used twice. Takes a SHA-256 hash.';
