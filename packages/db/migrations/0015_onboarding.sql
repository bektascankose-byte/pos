-- =============================================================================
-- 0015_onboarding.sql
--
-- Employee onboarding checklists. One org-wide template, managed once;
-- hiring a new employee snapshots the template's active items into a fresh
-- per-employee checklist at that moment, so a later edit to the template
-- (renaming a task, retiring one) never rewrites what an already-hired
-- employee was actually asked to do -- the same reasoning
-- `purchase_order_lines.unit_cost` already captures a price at order time
-- rather than reading it live.
--
-- No new permissions: onboarding is squarely part of employee lifecycle, so
-- this reuses employee.view/employee.manage exactly as they already gate
-- every other employee-record change.
-- =============================================================================

CREATE TABLE onboarding_task_templates (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title       text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_template_title_not_blank CHECK (btrim(title) <> ''),
  UNIQUE (id, org_id)
);

CREATE TRIGGER onboarding_task_templates_touch BEFORE UPDATE ON onboarding_task_templates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One per employee -- started automatically the moment they're hired (see
-- EmployeesService.create / OnboardingService.startChecklistTx), never
-- created by hand, and never more than one per person.
CREATE TABLE onboarding_checklists (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  user_id      uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by   uuid,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,
  UNIQUE (user_id),
  UNIQUE (id, org_id)
);

CREATE TABLE onboarding_checklist_items (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id           uuid NOT NULL,
  checklist_id     uuid NOT NULL,
  -- Nullable and ON DELETE SET NULL on purpose: retiring or deleting a
  -- template item must never take a historical completion record with it.
  template_item_id uuid,
  title            text NOT NULL,
  sort_order       integer NOT NULL DEFAULT 0,
  is_completed     boolean NOT NULL DEFAULT false,
  completed_by     uuid,
  completed_at     timestamptz,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_item_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT onboarding_item_completed_consistent
    CHECK ((is_completed AND completed_at IS NOT NULL) OR (NOT is_completed AND completed_by IS NULL AND completed_at IS NULL)),
  FOREIGN KEY (checklist_id, org_id) REFERENCES onboarding_checklists (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (template_item_id, org_id) REFERENCES onboarding_task_templates (id, org_id) ON DELETE SET NULL
);

CREATE INDEX onboarding_checklist_items_checklist_idx ON onboarding_checklist_items (checklist_id, sort_order);

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE onboarding_task_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON onboarding_task_templates
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE onboarding_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON onboarding_checklists
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE onboarding_checklist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON onboarding_checklist_items
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
