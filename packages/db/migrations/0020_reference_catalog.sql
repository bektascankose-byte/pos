-- =============================================================================
-- 0020_reference_catalog.sql
--
-- Products this shop knows about but does not stock.
--
-- A legacy system's item file is mostly history: 8,649 rows of everything ever
-- scanned, against maybe a thousand things actually on the shelf. Loading all
-- of it into `products` would be wrong in both directions -- it would bury the
-- real catalog in dead SKUs, and it would tell the register, the reports and
-- every export that the shop sells things it hasn't carried in two years.
--
-- So it lives here instead: a lookup table, not a catalog. Nothing in it is
-- sellable, counted, priced or reported on. Its whole job is to answer one
-- question at the moment somebody scans something unfamiliar -- "what IS
-- this?" -- and to make turning that answer into a real catalog item one
-- click instead of a retyping exercise.
--
-- Deliberately not a `product_variants` row with a status of 'inactive'.
-- Status describes something that WAS stocked and no longer is; these were
-- never stocked here at all, and everything that reads the catalog would have
-- to learn a new exception to keep them out. A separate table needs no
-- exceptions: code that doesn't know about it cannot accidentally include it.
-- =============================================================================

CREATE TABLE reference_products (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- Where the row came from, so one supplier's file can be replaced without
  -- disturbing another's.
  source         text NOT NULL DEFAULT 'import',
  -- The scannable code, normalized. This is what a lookup matches on.
  scan_code      text NOT NULL,
  item_code      text,
  description    text,
  department     text,
  size           text,
  retail_minor   money_minor,
  cost           numeric(14,6),
  units_per_case integer,
  -- What the old system last believed was on hand. Evidence about whether
  -- this is a live line, never an authority -- stock in this system comes
  -- from the ledger and nowhere else.
  source_quantity numeric(14,3),
  -- Every other column of the source row, so re-importing is never needed to
  -- recover a field nobody thought to map.
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, scan_code)
);

-- The lookup this table exists for.
CREATE INDEX reference_products_code_idx ON reference_products (org_id, scan_code);
-- Searching by name, for when the barcode is rubbed off the box.
CREATE INDEX reference_products_description_idx
  ON reference_products (org_id, lower(description));

CREATE TRIGGER reference_products_touch BEFORE UPDATE ON reference_products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE reference_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON reference_products
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
