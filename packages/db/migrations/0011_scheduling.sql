-- =============================================================================
-- 0011_scheduling.sql
--
-- Employee scheduling: a roster of upcoming shifts. Nothing in the schema
-- before this migration answers "when is this employee supposed to work" --
-- `time_clock_entries` (0001) only records actual clock-in/out after the
-- fact, and `cash_sessions` is a register till session, not a work schedule.
-- This is a new, standalone concept.
--
-- Removing a shift is a status change (`cancelled`), never a DELETE, for the
-- same reason most other entities in this schema are soft-stated rather than
-- erased: a cancelled shift is a fact ("this was scheduled, then called off"),
-- not something that should silently disappear. It also means this table
-- needs no DELETE grant at all -- 0005's blanket SELECT/INSERT/UPDATE already
-- covers everything it does.
--
-- Deliberately not done here: overlap prevention is application level, not a
-- database exclusion constraint (that needs the btree_gist extension, which
-- nothing else in this schema uses yet, for a UX nicety rather than a
-- financial or inventory invariant). Recurring shift templates, availability,
-- and time-off requests are all out of scope for this pass.
-- =============================================================================

CREATE TYPE shift_status AS ENUM ('scheduled', 'cancelled');

CREATE TABLE shifts (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  store_id    uuid NOT NULL,
  user_id     uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      shift_status NOT NULL DEFAULT 'scheduled',
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, org_id)  REFERENCES users (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT shifts_time_order CHECK (ends_at > starts_at)
);

CREATE INDEX shifts_user_time_idx  ON shifts (user_id, starts_at);
CREATE INDEX shifts_store_time_idx ON shifts (store_id, starts_at) WHERE status = 'scheduled';

CREATE TRIGGER shifts_touch BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON shifts
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Permissions. Every role's grant in 0001 (and every later migration that
-- added a permission) is a one-time INSERT ... SELECT, not a live rule -- so
-- even 'owner'/'administrator' need an explicit grant here, the same as any
-- other role.
INSERT INTO permissions (key, category, description) VALUES
  ('schedule.view',   'admin', 'View the shift schedule'),
  ('schedule.manage', 'admin', 'Create, edit and cancel shifts')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('owner', 'administrator', 'manager')
  AND p.key IN ('schedule.view', 'schedule.manage')
ON CONFLICT DO NOTHING;

-- A shift lead can see who's working, not build the roster.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'shift_lead'
  AND p.key = 'schedule.view'
ON CONFLICT DO NOTHING;
