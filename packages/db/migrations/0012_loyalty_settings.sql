-- =============================================================================
-- 0012_loyalty_settings.sql
--
-- Loyalty program settings -- configuration only, no engine.
--
-- docs/ARCHITECTURE.md's own entity diagram names `loyalty_accounts` and
-- `loyalty_transactions` as the customer-facing side of a full points engine
-- (Phase 3: accrual on completed sales, redemption at checkout, both of which
-- would touch the register app). None of that exists yet, and this migration
-- does not build it. This is the piece a business configures before any of
-- that is wired up: what the program is called, whether it's on, and its
-- point rates. Nothing reads or writes these numbers except this settings
-- screen -- a sale completing today earns nothing, because nothing is
-- listening.
--
-- One row per org, `org_id` as its own primary key, because this is
-- genuinely a singleton (a business has one loyalty program's settings, not
-- a list of them) rather than a set of records. Kept out of
-- `organizations.settings` (the existing generic jsonb bucket) so its rates
-- get real column types and CHECK constraints instead of living as
-- unvalidated JSON.
-- =============================================================================

CREATE TABLE loyalty_settings (
  org_id                       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  name                         text NOT NULL DEFAULT 'Loyalty Rewards',
  is_active                    boolean NOT NULL DEFAULT false,
  earn_points_per_dollar       numeric(10,2) NOT NULL DEFAULT 1,
  redemption_points_per_dollar numeric(10,2) NOT NULL DEFAULT 100,
  minimum_redemption_points    integer,
  points_expire_after_days     integer,
  updated_by                   uuid,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loyalty_name_not_blank         CHECK (btrim(name) <> ''),
  CONSTRAINT loyalty_earn_rate_positive     CHECK (earn_points_per_dollar > 0),
  CONSTRAINT loyalty_redemption_rate_positive CHECK (redemption_points_per_dollar > 0),
  CONSTRAINT loyalty_min_redemption_nonneg  CHECK (minimum_redemption_points IS NULL OR minimum_redemption_points >= 0),
  CONSTRAINT loyalty_expiry_positive        CHECK (points_expire_after_days IS NULL OR points_expire_after_days > 0)
);

CREATE TRIGGER loyalty_settings_touch BEFORE UPDATE ON loyalty_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE loyalty_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON loyalty_settings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

INSERT INTO permissions (key, category, description) VALUES
  ('loyalty.view',   'loyalty', 'View loyalty program settings'),
  ('loyalty.manage', 'loyalty', 'Configure loyalty program settings')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('owner', 'administrator', 'manager')
  AND p.key IN ('loyalty.view', 'loyalty.manage')
ON CONFLICT DO NOTHING;
