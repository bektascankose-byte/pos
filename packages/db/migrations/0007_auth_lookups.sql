-- =============================================================================
-- 0007_auth_lookups.sql
--
-- Two narrow SECURITY DEFINER functions for the authentication path.
--
-- The problem they solve is structural, not incidental. Row level security
-- denies when `app.org_id` is unset, which is the correct default and the whole
-- reason tenancy fails closed. But authentication has a chicken and egg
-- problem: the organization is not known until the user is found, so the one
-- query that finds the user cannot be scoped to an organization.
--
-- Three ways to resolve that, and only one is good:
--
--   a) Let the API connect as a role that bypasses RLS. This trades a real
--      isolation guarantee for one query's convenience. No.
--   b) Add a policy exception on `users` permitting unscoped reads. That opens
--      the entire table, including every column, to any query that forgets to
--      set a context. No.
--   c) Expose exactly the lookup authentication needs, and nothing else,
--      through a function that runs as the owner. The attack surface becomes
--      one function signature with a fixed column list instead of a table.
--
-- (c). These functions return only what the login and refresh paths verify
-- against, and they are the ONLY place in the system that reads across tenants.
--
-- Both are `STABLE` and pin `search_path`, because a SECURITY DEFINER function
-- with a mutable search_path can be hijacked by a caller who creates a shadow
-- table earlier in the path.
-- =============================================================================

-- Look up a user by email for password verification.
--
-- Deliberately returns the hash rather than doing the comparison here: Argon2
-- verification belongs in the application, where the parameters live alongside
-- the code that chose them, and a SQL side comparison would be far harder to
-- make constant time.
--
-- Returns at most one row. Email is unique per organization, and the API treats
-- more than one match as a configuration error rather than picking one.
CREATE OR REPLACE FUNCTION auth_lookup_user(p_email text)
RETURNS TABLE (
  id            uuid,
  org_id        uuid,
  password_hash text,
  full_name     text,
  display_name  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT u.id, u.org_id, u.password_hash, u.full_name, u.display_name
  FROM users u
  WHERE u.email = lower(p_email)
    AND u.status = 'active'
  LIMIT 1;
$fn$;

-- Look up a refresh session by token hash.
--
-- The caller presents a bearer token and nothing else, so this has the same
-- chicken and egg shape as the login lookup. It takes a SHA-256 hash, never a
-- token: the raw value never reaches the database, and a query log or a
-- statement sample therefore cannot leak a working session.
--
-- `rotated_at` and `revoked_at` come back so the application can detect reuse.
-- A token presented after rotation means two parties hold it, which means one
-- of them stole it, and the whole family is revoked.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_token_hash text)
RETURNS TABLE (
  id          uuid,
  org_id      uuid,
  user_id     uuid,
  family_id   uuid,
  device_id   uuid,
  rotated_at  timestamptz,
  revoked_at  timestamptz,
  expires_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT s.id, s.org_id, s.user_id, s.family_id, s.device_id,
         s.rotated_at, s.revoked_at, s.expires_at
  FROM auth_sessions s
  WHERE s.token_hash = p_token_hash
  LIMIT 1;
$fn$;

-- EXECUTE is revoked from PUBLIC first. A SECURITY DEFINER function is granted
-- to PUBLIC by default, which would make these callable by any future role.
REVOKE EXECUTE ON FUNCTION auth_lookup_user(text)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_lookup_session(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth_lookup_user(text)    TO snappos_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION auth_lookup_session(text) TO snappos_app';
  END IF;
END $$;

COMMENT ON FUNCTION auth_lookup_user(text) IS
  'Cross tenant by necessity: the org is unknown until the user is found. '
  'Returns only the columns password verification needs.';

COMMENT ON FUNCTION auth_lookup_session(text) IS
  'Cross tenant by necessity: a bearer token carries no org. Takes a SHA-256 '
  'hash, never a raw token.';
