-- =============================================================================
-- 0005_rls.sql
-- Row level security as defense in depth.
--
-- Tenancy is enforced three ways and this is the last of them:
--   1. org_id on every query, through the repository layer
--   2. composite foreign keys (id, org_id), so a cross tenant reference cannot
--      physically be inserted
--   3. RLS, which catches the day someone writes a query that forgets step 1
--
-- The application connects as snappos_app, which is NOT the table owner and
-- does NOT have BYPASSRLS. Migrations run as snappos_migrator, which owns the
-- tables and therefore bypasses these policies. That split is what makes it
-- safe to apply policies without breaking seeds and backfills.
--
-- Every request sets: SET LOCAL app.org_id = '<uuid>';
-- If it is unset the policy evaluates to NULL, which denies. Fail closed.
-- =============================================================================

DO $mig$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p')          -- tables and partitioned parents
      AND NOT c.relispartition              -- partitions inherit the parent policy
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);

    -- Tables where org_id is nullable (platform defaults such as roles,
    -- compliance_rules and feature_flags) must still expose the shared rows.
    EXECUTE format($pol$
      CREATE POLICY org_isolation ON public.%I
        USING (
          org_id IS NULL
          OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        )
        WITH CHECK (
          org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        )
    $pol$, r.relname);

    n := n + 1;
  END LOOP;

  RAISE NOTICE 'RLS enabled on % tables', n;
END $mig$;

-- Application role. Created here for completeness; in managed environments the
-- role is provisioned by Terraform and this block is a no-op.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    CREATE ROLE snappos_app NOLOGIN;
  END IF;
END $roles$;

GRANT USAGE ON SCHEMA public TO snappos_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO snappos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO snappos_app;
-- Deliberately no blanket DELETE. Deletion is granted per table, and never on
-- sales, payments, refunds or the ledger.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO snappos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO snappos_app;
