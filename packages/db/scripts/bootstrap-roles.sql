-- =============================================================================
-- bootstrap-roles.sql
--
-- The two role split that makes row level security mean something.
--
-- RLS is a no-op for the table owner. If the application connects as the role
-- that owns the tables, every policy in 0005_rls.sql is decoration. So:
--
--   snappos_migrator  owns the tables. Runs migrations, seeds and backfills.
--                     Bypasses RLS by virtue of ownership. Never used by the API.
--   snappos_app       the API's role. Not an owner, no BYPASSRLS, DML only.
--                     Every policy applies to it.
--
-- Run once per database, as a superuser, before the first migration.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    CREATE ROLE snappos_app LOGIN NOINHERIT PASSWORD 'dev_only_not_a_secret';
  END IF;
END $$;

-- Explicitly strip anything that would let the app role read around a policy.
ALTER ROLE snappos_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- CONNECT is per database and the database name is not known statically here.
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO snappos_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO snappos_app;

-- DML only. No DDL, no TRUNCATE: dropping or emptying a financial table is not
-- something the application is permitted to do, even with a bug.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO snappos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO snappos_app;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO snappos_app;

-- And the same for anything a later migration creates.
ALTER DEFAULT PRIVILEGES FOR ROLE snappos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO snappos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE snappos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO snappos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE snappos_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO snappos_app;
