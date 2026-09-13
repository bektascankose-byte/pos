-- =============================================================================
-- 0014_invoice_imports.sql
--
-- Invoice staging: a place for an uploaded vendor invoice (and whatever an
-- AI extraction step made of it) to sit for human review before anything it
-- says becomes a real purchase order, a real receipt, or real stock. Nothing
-- in this migration reads a file or calls anything external -- it is pure
-- schema, the same order this project always builds in: the shape first,
-- the pipeline that fills it after.
--
-- No new permissions -- reuses purchasing.view/create/receive exactly as
-- purchase orders themselves already do; an invoice import graduates into
-- one, it doesn't need its own trust boundary.
-- =============================================================================

CREATE TYPE invoice_import_status AS ENUM ('uploaded', 'parsed', 'reviewed', 'committed', 'failed');

CREATE TYPE invoice_import_line_status AS ENUM ('pending', 'matched', 'split', 'new_product', 'ignored');

CREATE TABLE invoice_imports (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id               uuid NOT NULL,
  store_id             uuid NOT NULL,
  -- Nullable: which vendor sent this may not be known until the file is
  -- parsed (or ever, for a document with no clean vendor identification).
  vendor_id            uuid,
  -- Set once review commits this import to a real order -- see
  -- PurchasingService.createPurchaseOrderTx/receivePurchaseOrderTx.
  purchase_order_id    uuid,
  source_object_key    text NOT NULL,
  source_content_type  text NOT NULL,
  source_filename      text NOT NULL,
  source_format        text NOT NULL,   -- 'pdf' | 'png' | 'jpg' | 'csv' | 'edi'
  invoice_total_minor  money_minor,
  vendor_invoice_no    text,
  status               invoice_import_status NOT NULL DEFAULT 'uploaded',
  parse_error          text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  committed_at         timestamptz,
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (vendor_id, org_id) REFERENCES vendors (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (purchase_order_id, org_id) REFERENCES purchase_orders (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);

CREATE INDEX invoice_imports_store_idx ON invoice_imports (store_id, created_at DESC);

CREATE TRIGGER invoice_imports_touch BEFORE UPDATE ON invoice_imports
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE invoice_import_lines (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id             uuid NOT NULL,
  invoice_import_id  uuid NOT NULL,
  line_no            integer NOT NULL,
  -- Lineage for "Add Variants": the original ambiguous line flips to
  -- status='split' and each variant a human resolves it into is a new
  -- sibling row referencing it here. Not part of a unique (import, line_no)
  -- pair on purpose -- a split child appends rather than fighting the
  -- parent for a slot in the numbering.
  split_from_line_id uuid REFERENCES invoice_import_lines (id) ON DELETE SET NULL,
  raw_text           text NOT NULL,
  parsed_quantity    numeric(14,3),
  parsed_unit_cost   numeric(14,6),
  parsed_description text,
  parsed_vendor_sku  text,
  -- Everything below is a suggestion. Nothing in this system writes a real
  -- catalog or inventory row because of what these columns say -- a human
  -- reviewing this line does that, through the real endpoints that already
  -- exist, with these values as a starting point rather than an instruction.
  ai_suggested_variant_id           uuid,
  ai_confidence                     numeric(5,4),
  ai_suggested_brand                text,
  ai_suggested_category             text,
  ai_suggested_product_description  text,
  is_ambiguous_multi_item boolean NOT NULL DEFAULT false,
  status                  invoice_import_line_status NOT NULL DEFAULT 'pending',
  resolved_variant_id     uuid,
  resolved_by             uuid,
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_import_id, org_id) REFERENCES invoice_imports (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (ai_suggested_variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE SET NULL,
  CONSTRAINT invoice_import_lines_confidence_range
    CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1)
);

CREATE INDEX invoice_import_lines_import_idx ON invoice_import_lines (invoice_import_id, line_no);

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE invoice_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invoice_imports
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE invoice_import_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invoice_import_lines
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
