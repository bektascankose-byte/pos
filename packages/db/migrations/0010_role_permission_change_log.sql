-- role_permissions never wrote to change_log.
--
-- 0008 added a change_log trigger to every table a register's incremental
-- sync cares about, except this one -- so granting or revoking a permission
-- on a role (0009 did exactly this, for cashier + sale.price_override) never
-- marked the "employees" scope dirty. An already-provisioned register never
-- re-pulled its cashiers' permissions; only a full re-provision picked up the
-- new grant, because that path ignores the cursor and asks for everything.
--
-- role_permissions cannot reuse log_change() unmodified: that function reads
-- org_id straight off the changed row, and this table has no org_id column at
-- all -- it is a pure (role_id, permission_key) join. The org has to come
-- from the role.
--
-- A role is either org-owned (roles.org_id set, a custom role belonging to
-- one tenant) or a system role (roles.org_id null -- cashier, manager, and
-- the rest, shared by every organization since 0001 seeded them once with no
-- org_id). A permission change on a system role is not one org's news: every
-- organization's cashiers hold that role, so every organization's registers
-- need to hear about it -- one change_log row per organization, not one row
-- with org_id null, because change_log.org_id is exactly what scopes a
-- register's own cursor query. A null there would make the row invisible to
-- every register instead of visible to all of them.
--
-- Writing one row per organization only works at all because this table is
-- written by migrations and seeds, run as snappos_migrator, which owns the
-- tables and bypasses RLS. Nothing in the live API writes role_permissions
-- today -- it is read-only there (auth.service.ts, sync.service.ts) -- so
-- this trigger only ever fires outside any one org's request-scoped RLS
-- session. If a live admin route is ever added to edit a role's grants, it
-- will almost certainly be scoped to an org-owned role, which the branch
-- below already handles correctly: one row, at that role's own org_id, which
-- passes change_log's own RLS check unmodified.

CREATE OR REPLACE FUNCTION log_change_role_permission() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected_role_id uuid := COALESCE(NEW.role_id, OLD.role_id);
  role_org_id       uuid;
BEGIN
  SELECT org_id INTO role_org_id FROM roles WHERE id = affected_role_id;

  -- The role was deleted in the same transaction (cascade from a role
  -- delete). Nobody can hold a deleted role, so there is nothing to tell a
  -- register.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF role_org_id IS NOT NULL THEN
    INSERT INTO change_log (org_id, store_id, entity_type, entity_id, op, payload_hash)
    VALUES (
      role_org_id, NULL, 'role', affected_role_id, lower(TG_OP)::change_op,
      md5(to_jsonb(COALESCE(NEW, OLD))::text)
    );
  ELSE
    INSERT INTO change_log (org_id, store_id, entity_type, entity_id, op, payload_hash)
    SELECT o.id, NULL, 'role', affected_role_id, lower(TG_OP)::change_op,
           md5(to_jsonb(COALESCE(NEW, OLD))::text)
    FROM organizations o;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION log_change_role_permission() IS
  'Writes a change_log notification (scope "employees") when a role''s '
  'permission set changes. Fans out to every organization for a system role '
  '(roles.org_id null), since every org''s registers use it.';

CREATE TRIGGER log_change_role_permissions
  AFTER INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION log_change_role_permission();
