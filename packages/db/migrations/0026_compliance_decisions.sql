-- =============================================================================
-- 0026_compliance_decisions.sql
--
-- What was decided, and on what basis.
--
-- `compliance_rules` has been here since 0002, complete, conservative, and
-- already seeded with a platform baseline whose authority notes say
-- "CONFIRM WITH COUNSEL" -- including a denial of ENDS delivery citing the
-- same PACT Act analysis the storefront plan flagged. Nothing had ever read
-- it. This migration adds the one piece it was missing: somewhere to write
-- down what the engine concluded.
--
-- NOT A CACHE. Rules change, and a stored decision replayed as though it were
-- still current is worse than no decision at all. What this is for is being
-- able to show, afterwards, exactly which rules were in force when an order
-- was accepted -- the difference between believing you complied and
-- demonstrating it to somebody who is asking.
--
-- That is also why `matched_rule_ids` is a plain uuid array rather than a
-- foreign key. Deleting a rule must not be able to rewrite the history of
-- decisions that were made under it.
-- =============================================================================

CREATE TABLE compliance_decisions (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  -- Nullable: a decision is made while a cart is still being built, before
  -- there is any order for it to belong to.
  order_id       uuid,
  variant_id     uuid NOT NULL,
  channel        compliance_channel NOT NULL,

  allowed        boolean NOT NULL,
  -- Shown to a person. A refusal nobody can act on becomes a phone call.
  reason         text NOT NULL,
  minimum_age    smallint,
  requires_id_scan               boolean NOT NULL DEFAULT false,
  requires_manager               boolean NOT NULL DEFAULT false,
  requires_provider_verification boolean NOT NULL DEFAULT false,
  -- Whether the denying rule allowed a manager to override it. Recorded even
  -- when nobody did, so "could this have been overridden" is answerable.
  overridable    boolean NOT NULL DEFAULT false,

  matched_rule_ids uuid[] NOT NULL DEFAULT '{}',
  -- The jurisdiction the rules were matched against: which country, region,
  -- county, city and store. For a delivery this is the destination, not the
  -- shop, and being able to prove which was used is the point.
  jurisdiction     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The exact instant evaluated against, so a decision can be reproduced
  -- rather than merely believed. The evaluator never reads a clock of its own.
  evaluated_as_of timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT compliance_decision_reason_present CHECK (btrim(reason) <> '')
);

CREATE INDEX compliance_decisions_order_idx ON compliance_decisions (order_id)
  WHERE order_id IS NOT NULL;

-- Refusals are what get reviewed: a category denying everything usually means
-- a rule is wrong, not that a hundred customers were.
CREATE INDEX compliance_decisions_denied_idx ON compliance_decisions (org_id, created_at DESC)
  WHERE allowed = false;

ALTER TABLE compliance_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance_decisions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

INSERT INTO permissions (key, category, description) VALUES
  ('compliance.view',   'compliance', 'View compliance rules and what they decided'),
  ('compliance.manage', 'compliance', 'Create and change compliance rules')
ON CONFLICT (key) DO NOTHING;

-- Deliberately narrow. Changing what may legally be sold is an owner-level
-- act; a manager can read the rules and see what was refused.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'owner'
  AND p.key IN ('compliance.view', 'compliance.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'compliance.view' FROM roles r
WHERE r.org_id IS NULL AND r.key IN ('administrator', 'manager')
ON CONFLICT DO NOTHING;
