-- =============================================================================
-- 0019_receiving.sql
--
-- Stock that arrived before its paperwork did.
--
-- The schema already knows two ways goods come in, and neither fits what
-- actually happens most days:
--
--   * a purchase order, received against what was ordered -- but plenty of
--     deliveries were never ordered through this system at all;
--   * an uploaded invoice, parsed and committed -- but the invoice is often
--     in the driver's hand, in an email that hasn't arrived, or in a pile by
--     the till a week later.
--
-- What happens in between is somebody standing over a box with a scanner.
-- That is what these tables are: a count of what physically turned up, taken
-- immediately, with the vendor and the invoice attached later if at all.
--
-- `receiving_lines.variant_id` is nullable on purpose. Scanning a code that
-- matches nothing in the catalog is not an error to refuse -- it is the most
-- common moment for a *new* product to enter a shop. The line records what
-- was scanned either way, and a human resolves it before the session can be
-- committed.
--
-- Committing posts ordinary `receiving` movements through the same inventory
-- ledger everything else uses. Nothing here touches `inventory_levels`
-- directly, and an uncommitted session has moved no stock at all.
-- =============================================================================

CREATE TYPE receiving_status AS ENUM ('open', 'committed', 'cancelled');

CREATE TABLE receiving_sessions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  store_id     uuid NOT NULL,
  -- Both nullable, and that is the point of this table: a delivery can be
  -- counted before anyone knows which vendor's paperwork it belongs to.
  vendor_id    uuid,
  invoice_import_id uuid,
  -- Whatever is written on the box or the packing slip.
  reference    text,
  note         text,
  status       receiving_status NOT NULL DEFAULT 'open',
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  FOREIGN KEY (store_id, org_id)  REFERENCES stores  (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (vendor_id, org_id) REFERENCES vendors (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (invoice_import_id, org_id) REFERENCES invoice_imports (id, org_id) ON DELETE SET NULL,
  UNIQUE (id, org_id),
  CONSTRAINT receiving_committed_at_set
    CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);

CREATE INDEX receiving_sessions_store_idx ON receiving_sessions (store_id, created_at DESC);

CREATE TRIGGER receiving_sessions_touch BEFORE UPDATE ON receiving_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE receiving_lines (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  session_id  uuid NOT NULL,
  -- Null until a human says which item this code is. See the header: an
  -- unrecognized scan is usually a new product, not a mistake.
  variant_id  uuid,
  -- Exactly what came off the scanner, kept even after the line is resolved,
  -- so a mis-scan can be told apart from a mis-mapping afterwards.
  scanned_code text NOT NULL,
  quantity    numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- What it cost, when it is known at receiving time. Left null when the
  -- invoice hasn't turned up yet, which is the usual case here.
  unit_cost   numeric(14,6) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, org_id) REFERENCES receiving_sessions (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants  (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX receiving_lines_session_idx ON receiving_lines (session_id, created_at);
CREATE INDEX receiving_lines_variant_idx ON receiving_lines (variant_id) WHERE variant_id IS NOT NULL;

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE receiving_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON receiving_sessions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE receiving_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON receiving_lines
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
