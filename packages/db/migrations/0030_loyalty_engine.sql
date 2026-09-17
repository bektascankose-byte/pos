-- =============================================================================
-- 0030_loyalty_engine.sql
--
-- Points, earned on real sales.
--
-- 0012 gave the program a name, an on/off switch and its rates, and nothing
-- that used them. This adds the ledger those rates write to: one row per thing
-- that changed a customer's points, from the counter or the website alike,
-- because both kinds of sale arrive through the same intake.
--
-- A LEDGER, NOT A BALANCE COLUMN. A balance that is updated in place cannot
-- explain itself, and "why do I only have 40 points" is a question a shop has
-- to be able to answer at the counter. The balance is the sum of the ledger,
-- worked out by a view, so the two can never disagree.
--
-- WHAT DOES NOT EARN. Federal rules forbid giving anything in exchange for
-- buying cigarettes or smokeless tobacco, and points you can spend are
-- something. `excluded_regulated_classes` names the product classes that never
-- earn, and starts with those two. Which classes belong there is a legal
-- question for the shop's attorney; this only makes the answer enforceable.
--
-- VERIFIED PHONES. The register finds a loyalty member by phone number, typed
-- by the cashier. Once points are worth something, a phone number on an
-- online account has to be proven, or anyone could type in a stranger's number
-- and collect their points. `verified_phone` records which number the customer
-- proved with a texted code; a number changed afterwards is simply no longer
-- the verified one.
-- =============================================================================

CREATE TYPE loyalty_entry_kind AS ENUM (
  'earn',      -- a completed sale
  'reverse',   -- a void or refund taking back what that sale earned
  'redeem',    -- points spent
  'adjust',    -- a person corrected the balance, and said why
  'expire'     -- points that ran out
);

ALTER TABLE loyalty_settings
  ADD COLUMN excluded_regulated_classes text[] NOT NULL DEFAULT '{cigarette,smokeless}';

CREATE TABLE loyalty_ledger (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  customer_id  uuid NOT NULL,
  kind         loyalty_entry_kind NOT NULL,
  points       integer NOT NULL,

  -- What caused it. A sale for earning and for a void's reversal, a refund for
  -- a refund's reversal.
  sale_id      uuid,
  refund_id    uuid,

  -- The amount the points were worked out from, and the rate used, as they
  -- were at the time. A rate changed next month must not rewrite why a sale
  -- earned what it earned.
  basis_minor  money_minor,
  rate         numeric(10,2),

  note         text,
  created_by   uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_id, org_id)     REFERENCES sales (id, org_id)     ON DELETE RESTRICT,
  FOREIGN KEY (refund_id, org_id)   REFERENCES refunds (id, org_id)   ON DELETE RESTRICT,
  UNIQUE (id, org_id),

  CONSTRAINT loyalty_points_nonzero    CHECK (points <> 0),
  CONSTRAINT loyalty_earn_from_sale    CHECK (kind <> 'earn' OR (points > 0 AND sale_id IS NOT NULL)),
  CONSTRAINT loyalty_reverse_explained CHECK (kind <> 'reverse' OR (points < 0 AND sale_id IS NOT NULL)),
  CONSTRAINT loyalty_redeem_negative   CHECK (kind <> 'redeem' OR points < 0),
  CONSTRAINT loyalty_expire_negative   CHECK (kind <> 'expire' OR points < 0),
  CONSTRAINT loyalty_adjust_explained  CHECK (kind <> 'adjust' OR btrim(COALESCE(note, '')) <> '')
);

-- A sale earns once. The intake that writes a sale can be replayed by a
-- register retrying an upload, and this is what makes the replay earn nothing.
CREATE UNIQUE INDEX loyalty_one_earn_per_sale ON loyalty_ledger (sale_id) WHERE kind = 'earn';
-- A refund takes points back once, and a void takes back the rest once.
CREATE UNIQUE INDEX loyalty_one_reverse_per_refund ON loyalty_ledger (refund_id)
  WHERE kind = 'reverse' AND refund_id IS NOT NULL;
CREATE UNIQUE INDEX loyalty_one_void_reverse_per_sale ON loyalty_ledger (sale_id)
  WHERE kind = 'reverse' AND refund_id IS NULL;
CREATE INDEX loyalty_ledger_customer_idx ON loyalty_ledger (customer_id, occurred_at DESC);

-- History is not edited. The one thing that may change is whose it is: when
-- an online account and an in-store record turn out to be the same person,
-- their points come together rather than staying split across two rows.
CREATE OR REPLACE FUNCTION guard_loyalty_ledger() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.kind, NEW.points, NEW.sale_id, NEW.refund_id,
      NEW.basis_minor, NEW.rate, NEW.note, NEW.created_by, NEW.occurred_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.kind, OLD.points, OLD.sale_id, OLD.refund_id,
      OLD.basis_minor, OLD.rate, OLD.note, OLD.created_by, OLD.occurred_at)
  THEN
    RAISE EXCEPTION 'loyalty entry % cannot be edited; record an adjustment instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER loyalty_ledger_immutable BEFORE UPDATE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_loyalty_ledger();
CREATE TRIGGER loyalty_ledger_no_delete BEFORE DELETE ON loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

-- The balance, as the sum of its history. `security_invoker` because a view
-- otherwise runs as its owner, which bypasses row-level security.
CREATE VIEW loyalty_balances WITH (security_invoker = true) AS
SELECT org_id,
       customer_id,
       sum(points)::integer AS points,
       sum(points) FILTER (WHERE kind = 'earn')::integer AS lifetime_earned,
       max(occurred_at) AS last_activity_at
FROM loyalty_ledger
GROUP BY org_id, customer_id;

ALTER TABLE loyalty_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON loyalty_ledger
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Proving a phone number, for accounts on the website.
-- -----------------------------------------------------------------------------

ALTER TABLE customer_credentials
  ADD COLUMN verified_phone    text,
  ADD COLUMN phone_verified_at timestamptz,
  ADD CONSTRAINT customer_credentials_phone_verified_pair
    CHECK ((verified_phone IS NULL) = (phone_verified_at IS NULL));

-- Not usable inside this migration's own transaction, and not used here.
ALTER TYPE customer_token_purpose ADD VALUE 'verify_phone';

INSERT INTO permissions (key, category, description) VALUES
  ('loyalty.adjust', 'loyalty', 'Add or remove loyalty points by hand, with a reason')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator', 'manager')
  AND p.key = 'loyalty.adjust'
ON CONFLICT DO NOTHING;
