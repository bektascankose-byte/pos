-- =============================================================================
-- 0033_platform_rule_lifts.sql
--
-- How a shop turns on something the platform ships switched off.
--
-- 0002 seeds a conservative baseline, and two of those rules are holds rather
-- than prohibitions: "Delivery of ENDS requires review" and "No shipping of
-- ENDS". Both deny until somebody has done the legal work, and say so in their
-- own authority notes. But a shop cannot end a platform rule -- it is not the
-- shop's rule, and it stands in front of every other shop on the platform --
-- and an allow the shop writes does not help either, because a deny ends an
-- evaluation wherever it appears in the matched set. Which left the delivery
-- half of this product permanently unreachable for the goods it exists to
-- sell: a shop could switch delivery on, list a vape for it, and the website
-- would still refuse every cart, with nothing anywhere saying why.
--
-- A LIFT IS NOT AN OVERRIDE. The evaluator is untouched. A deny still ends the
-- matter wherever it is found, the conformance fixtures still hold, and the
-- Kotlin engine does not have to learn a new precedence rule -- which matters,
-- because a rule that behaved differently on the register than on the website
-- is the one failure this design refuses to allow. What a lift changes is
-- which rules the loader hands the evaluator for one organization, which is
-- the same kind of decision an effective date already makes. A lifted rule is
-- not in force here; everything left is judged exactly as before.
--
-- WHAT IT COSTS TO LIFT ONE. The date counsel reviewed it, the permit it is
-- held under, and a note. All required, because the question an auditor asks
-- is not whether delivery was switched on but who decided it could be and on
-- what authority. Lifting is the owner's to do and nobody else's.
--
-- ONE SHOP AT A TIME. A lift names an organization and a rule. It cannot reach
-- another shop, and it cannot touch a rule the platform later adds.
--
-- APPEND ONLY, like every other compliance record. A lift is withdrawn by
-- dating it, never deleted, so "could this shop deliver a vape on the 14th of
-- March" stays answerable next year.
-- =============================================================================

CREATE TABLE compliance_rule_lifts (
  id      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- RESTRICT, not CASCADE: a platform rule that something was traded under
  -- cannot be deleted out from under the record that it was lifted.
  rule_id uuid NOT NULL REFERENCES compliance_rules(id) ON DELETE RESTRICT,

  -- The attestation. Not decoration: this is the whole reason a lift is
  -- allowed at all.
  counsel_reviewed_on date NOT NULL,
  permit_reference    text NOT NULL,
  authority_note      text NOT NULL,

  lifted_by      uuid NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  withdrawn_by   uuid,
  withdrawn_note text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rule_lift_window CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT rule_lift_permit_present CHECK (btrim(permit_reference) <> ''),
  -- Long enough to be a sentence. "ok" is not an authority.
  CONSTRAINT rule_lift_note_present CHECK (length(btrim(authority_note)) >= 10),
  -- A review that has not happened yet is not a review.
  CONSTRAINT rule_lift_review_not_future CHECK (counsel_reviewed_on <= (now() AT TIME ZONE 'UTC')::date),
  CONSTRAINT rule_lift_withdrawal_complete
    CHECK ((effective_to IS NULL) = (withdrawn_by IS NULL))
);

-- One live lift per rule per shop. Lifting twice is not twice as lifted, and
-- two live rows would make "when was this lifted" ambiguous.
CREATE UNIQUE INDEX compliance_rule_lifts_live_key
  ON compliance_rule_lifts (org_id, rule_id) WHERE effective_to IS NULL;

-- The loader's question, asked on every evaluation: which platform rules does
-- this organization not have in force right now.
CREATE INDEX compliance_rule_lifts_lookup_idx
  ON compliance_rule_lifts (rule_id, org_id) WHERE effective_to IS NULL;

CREATE TRIGGER compliance_rule_lifts_touch BEFORE UPDATE ON compliance_rule_lifts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- What may be lifted, and what may be changed afterwards.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guard_compliance_rule_lift() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  rule_org uuid;
  rule_is_platform boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT org_id IS NULL INTO rule_is_platform FROM compliance_rules WHERE id = NEW.rule_id;
    IF rule_is_platform IS NULL THEN
      RAISE EXCEPTION 'no such compliance rule' USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- A shop's own rule is ended, not lifted. Allowing both would leave two
    -- ways to switch off one rule and two places to look for the reason.
    IF NOT rule_is_platform THEN
      RAISE EXCEPTION 'only a platform rule can be lifted; end your own rule instead'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- A lift is a record of a decision. Withdrawing it is the only thing that
  -- can happen to it afterwards.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
     OR NEW.counsel_reviewed_on IS DISTINCT FROM OLD.counsel_reviewed_on
     OR NEW.permit_reference IS DISTINCT FROM OLD.permit_reference
     OR NEW.authority_note IS DISTINCT FROM OLD.authority_note
     OR NEW.lifted_by IS DISTINCT FROM OLD.lifted_by
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'a lift cannot be edited; withdraw it and record a new one'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'a withdrawn lift stays withdrawn' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $fn$;

CREATE TRIGGER compliance_rule_lifts_guard
  BEFORE INSERT OR UPDATE ON compliance_rule_lifts
  FOR EACH ROW EXECUTE FUNCTION guard_compliance_rule_lift();

CREATE TRIGGER compliance_rule_lifts_no_delete BEFORE DELETE ON compliance_rule_lifts
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

COMMENT ON TABLE compliance_rule_lifts IS
  'A platform rule an organization has taken out of force for itself after counsel review. '
  'Read by the rule loader, never by the evaluator: the engine is unchanged.';

-- -----------------------------------------------------------------------------
-- Tenancy. Unlike compliance_rules, there is nothing shared here: a lift
-- belongs to exactly one shop and no other shop may see it.
-- -----------------------------------------------------------------------------

ALTER TABLE compliance_rule_lifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON compliance_rule_lifts
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
