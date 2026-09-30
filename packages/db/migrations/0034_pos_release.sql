-- =============================================================================
-- 0034_pos_release.sql
--
-- SEND TO POS. Until now a catalog edit reached every register within a
-- minute of being saved, whether or not it was finished: a product created
-- with no price yet, a flavour added before its barcode was known, a name
-- half retyped. The owner asked for the opposite: the back office is where
-- the catalog is worked on, and the registers get it when someone presses
-- Send.
--
-- So the registers are no longer served the live catalog. They are served
-- `pos_catalog_variants`: each sellable variant exactly as it stood the last
-- time its product was sent. Sending a product replaces that product's rows
-- with its live state (`pos_live_variants`), and writes a `pos_releases` row,
-- whose change_log entry is what tells the registers to pull.
--
-- WHAT WAITS FOR SEND: names, flavours, barcodes, prices, photos, brand,
-- category, tax category, age restriction, and whether an item is on sale at
-- all. Everything the register shows or enforces about an item.
--
-- WHAT DOES NOT WAIT: stock levels (advisory on the register, and they move
-- with every sale), cost (the register only uses it for below-cost warnings,
-- and invoices change it constantly -- a Send page full of cost drift would
-- bury the changes a person actually made), categories themselves, tax rates
-- and staff.
--
-- No foreign key from `pos_catalog_variants` to `product_variants`, on
-- purpose: a register keeps selling what it was sent until the next Send, so
-- the sent copy has to outlive a variant deleted in the back office. The
-- delete path refuses to hard-delete anything that is still on the registers
-- for the same reason -- a sale of it would otherwise be refused on upload.
-- =============================================================================

-- Where a photo came from, when it did not come from someone's own camera.
-- The AI image finder fills it with the page it took the picture from, so the
-- provenance of every stock photo stays on record next to the photo.
ALTER TABLE product_images ADD COLUMN source_url text;

-- The catalog as a register would receive it right now if everything were
-- sent. One row per active variant of an active product.
--
-- security_invoker, so reading it as the app role goes through the same
-- row-level security as reading the tables underneath it would.
CREATE VIEW pos_live_variants WITH (security_invoker = true) AS
SELECT
  v.id         AS variant_id,
  v.org_id,
  v.product_id,
  -- Every key the register's snapshot row carries except `cost`, which is
  -- joined live at serve time (see the header). jsonb, so key order and
  -- whitespace never make two identical rows compare unequal.
  jsonb_build_object(
    'id', v.id,
    'product_id', v.product_id,
    'product_name', p.name,
    'variant_name', v.variant_name,
    'sku', v.sku,
    'plu', v.plu,
    'brand_id', p.brand_id,
    'brand_name', b.name,
    'category_id', p.category_id,
    'tax_category_id', p.tax_category_id,
    'case_quantity', v.case_quantity,
    'sort_order', v.sort_order,
    'is_default', v.is_default,
    'status', v.status,
    'minimum_age', pc.minimum_age,
    'id_scan_required', COALESCE(pc.id_scan_required, false),
    'regulated_class', pc.regulated_class,
    -- The variant's own photo wins; failing that the product's.
    'image_url', (
      SELECT '/api/v1/catalog/images/' || i.id || '?size=thumb'
      FROM product_images i
      WHERE i.variant_id = v.id OR i.product_id = p.id
      ORDER BY (i.variant_id IS NULL), i.sort_order, i.created_at
      LIMIT 1
    )
  ) AS payload,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', vb.id,
             'variant_id', vb.variant_id,
             'barcode', vb.barcode,
             'kind', vb.kind,
             'units', vb.units::text,
             'is_primary', vb.is_primary)
           ORDER BY vb.barcode)
    FROM variant_barcodes vb
    WHERE vb.variant_id = v.id
  ), '[]'::jsonb) AS barcodes,
  -- Current and scheduled prices for every store. The snapshot narrows these
  -- to the asking register's store when it serves them.
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', vp.id,
             'variant_id', vp.variant_id,
             'store_id', vp.store_id,
             'kind', vp.kind,
             'price_minor', vp.price_minor::text,
             -- Spelled out in UTC rather than left to jsonb, whose rendering
             -- of a timestamptz follows the session's TimeZone. Two sessions
             -- in different zones would otherwise see the same price as a
             -- change waiting to be sent.
             'effective_from', to_char(vp.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
             'effective_to', to_char(vp.effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
           ORDER BY vp.id)
    FROM variant_prices vp
    WHERE vp.variant_id = v.id
      AND (vp.effective_to IS NULL OR vp.effective_to > now())
  ), '[]'::jsonb) AS prices
FROM product_variants v
JOIN products p ON p.id = v.product_id
LEFT JOIN brands b ON b.id = p.brand_id
LEFT JOIN product_compliance pc ON pc.product_id = p.id
WHERE v.status = 'active' AND p.status = 'active';

-- What the registers were last sent, one row per variant.
CREATE TABLE pos_catalog_variants (
  variant_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_id   uuid NOT NULL,
  payload      jsonb NOT NULL,
  barcodes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  prices       jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_at  timestamptz NOT NULL DEFAULT now(),
  released_by  uuid
);

CREATE INDEX pos_catalog_variants_product_idx ON pos_catalog_variants (org_id, product_id);

ALTER TABLE pos_catalog_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON pos_catalog_variants
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- One row per press of Send: what went, and who sent it. Its change_log entry
-- is the signal the registers pull on.
CREATE TABLE pos_releases (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_ids       uuid[] NOT NULL,
  variants_added    integer NOT NULL DEFAULT 0,
  variants_changed  integer NOT NULL DEFAULT 0,
  variants_removed  integer NOT NULL DEFAULT 0,
  released_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pos_releases_org_idx ON pos_releases (org_id, created_at DESC);

ALTER TABLE pos_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON pos_releases
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE TRIGGER log_change_pos_releases
  AFTER INSERT ON pos_releases
  FOR EACH ROW EXECUTE FUNCTION log_change('pos_release');

-- Everything already on sale is already on the registers. Starting the sent
-- copy empty would empty every till on the next pull; starting it from the
-- live catalog means nothing changes for a register until somebody sends.
-- Runs as the migrator, which owns these tables, so every organization is
-- copied regardless of row-level security.
INSERT INTO pos_catalog_variants (variant_id, org_id, product_id, payload, barcodes, prices)
SELECT variant_id, org_id, product_id, payload, barcodes, prices FROM pos_live_variants;
