-- =============================================================================
-- 0002_catalog.sql
-- Products, variants, barcodes, pricing, tax, vendors, compliance rules.
--
-- Central modelling decision: EVERYTHING SELLABLE IS A VARIANT.
-- A product with no flavors still gets exactly one variant row. Barcodes, cost,
-- price and stock live on the variant, never on the product. This removes a
-- large amount of branching from pricing, inventory, scanning and reporting,
-- and it is the single highest leverage decision in this schema.
-- =============================================================================

CREATE TYPE compliance_channel AS ENUM
  ('in_store', 'pickup', 'delivery', 'online_listing', 'ship');

CREATE TYPE compliance_effect AS ENUM
  ('allow', 'deny', 'require_age', 'require_id_scan',
   'require_manager', 'require_provider_verification');

CREATE TYPE price_kind AS ENUM ('regular', 'sale', 'map', 'msrp', 'cost_plus');

-- -----------------------------------------------------------------------------
-- Classification
-- -----------------------------------------------------------------------------

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  brand_family text,                     -- 'Geek Bar' groups 'Geek Bar Pulse' etc
  logo_url    text,
  status      entity_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX brands_org_name_key ON brands (org_id, lower(name));
CREATE TRIGGER brands_touch BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Materialized path rather than ltree, so no extension dependency and so the
-- path is readable in any client. 'vapes.disposable.geek-bar'
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  parent_id   uuid,
  slug        text NOT NULL,
  name        text NOT NULL,
  path        text NOT NULL,             -- dot delimited, maintained by the app
  depth       smallint NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0,
  tile_color  text,                      -- register category tile
  image_url   text,
  is_department boolean NOT NULL DEFAULT false,
  status      entity_status NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (parent_id, org_id) REFERENCES categories (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT categories_slug_fmt CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT categories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX categories_org_path_key ON categories (org_id, path);
CREATE INDEX categories_prefix_idx  ON categories (org_id, path text_pattern_ops);
CREATE INDEX categories_parent_idx  ON categories (parent_id, sort_order);
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Tax. Never a hard coded percentage: rates are effective dated rows, and the
-- TaxProvider abstraction can replace this table with a external service later
-- without touching checkout.
-- -----------------------------------------------------------------------------

CREATE TABLE tax_categories (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code        text NOT NULL,             -- 'STD', 'TOBACCO', 'EXEMPT', 'FOOD'
  name        text NOT NULL,
  description text,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX tax_categories_org_code_key ON tax_categories (org_id, code);

CREATE TABLE tax_rates (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id           uuid NOT NULL,
  store_id         uuid,                 -- null = every store in the org
  tax_category_id  uuid NOT NULL,
  name             text NOT NULL,        -- 'TX State', 'Killeen City'
  rate             numeric(9,6) NOT NULL CHECK (rate >= 0 AND rate < 1),
  -- Some jurisdictions tax per unit rather than ad valorem.
  per_unit_minor   money_minor NOT NULL DEFAULT 0,
  compounds        boolean NOT NULL DEFAULT false,
  apply_order      smallint NOT NULL DEFAULT 0,
  channel          compliance_channel,   -- null = every channel
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id)        REFERENCES stores (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (tax_category_id, org_id) REFERENCES tax_categories (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT tax_rates_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX tax_rates_lookup_idx
  ON tax_rates (org_id, tax_category_id, store_id, effective_from DESC);

-- -----------------------------------------------------------------------------
-- Products and variants
-- -----------------------------------------------------------------------------

CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name           text NOT NULL,
  short_name     text,                   -- receipt and register tile, 24 chars
  description    text,
  brand_id       uuid,
  category_id    uuid,
  manufacturer   text,
  tax_category_id uuid,
  unit_type      text NOT NULL DEFAULT 'each',   -- each | gram | ounce | ml | pack
  has_variants   boolean NOT NULL DEFAULT false,
  variant_axes   text[] NOT NULL DEFAULT '{}',   -- ['flavor'] or ['size','strength']
  image_url      text,
  tags           text[] NOT NULL DEFAULT '{}',
  status         entity_status NOT NULL DEFAULT 'active',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (brand_id, org_id)        REFERENCES brands (id, org_id)        ON DELETE SET NULL,
  FOREIGN KEY (category_id, org_id)     REFERENCES categories (id, org_id)    ON DELETE SET NULL,
  FOREIGN KEY (tax_category_id, org_id) REFERENCES tax_categories (id, org_id) ON DELETE SET NULL,
  UNIQUE (id, org_id)
);
CREATE INDEX products_org_status_idx ON products (org_id, status);
CREATE INDEX products_category_idx   ON products (category_id) WHERE status = 'active';
CREATE INDEX products_brand_idx      ON products (brand_id)    WHERE status = 'active';
CREATE INDEX products_tags_idx       ON products USING gin (tags);
CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE product_variants (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  product_id     uuid NOT NULL,
  sku            text NOT NULL,
  plu            text,                            -- short code for keypad entry
  variant_name   text,                            -- 'Miami Mint'. Null for single variant.
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {flavor, size, strength, color}
  is_default     boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,

  -- Costing. numeric(14,6) because a case of 12 at $5.00 is a unit cost of
  -- 0.416667 and truncating that to cents corrupts margin within weeks.
  cost           numeric(14,6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  average_cost   numeric(14,6) NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
  last_cost      numeric(14,6),
  case_quantity  integer NOT NULL DEFAULT 1 CHECK (case_quantity > 0),
  pack_quantity  integer NOT NULL DEFAULT 1 CHECK (pack_quantity > 0),

  -- Replenishment defaults. Per store overrides live in inventory_settings.
  reorder_point     numeric(14,3),
  reorder_quantity  numeric(14,3),
  min_quantity      numeric(14,3),
  max_quantity      numeric(14,3),
  lead_time_days    smallint,

  weight_grams   numeric(10,2),
  image_url      text,
  status         entity_status NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, org_id) REFERENCES products (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX variants_org_sku_key ON product_variants (org_id, upper(sku));
CREATE UNIQUE INDEX variants_org_plu_key ON product_variants (org_id, upper(plu)) WHERE plu IS NOT NULL;
CREATE UNIQUE INDEX variants_default_key ON product_variants (product_id) WHERE is_default;
CREATE INDEX variants_product_idx ON product_variants (product_id, sort_order);
CREATE INDEX variants_attrs_idx   ON product_variants USING gin (attributes);
CREATE TRIGGER variants_touch BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Many barcodes per variant: primary UPC, alternate UPC, case barcode, vendor
-- barcode. A scan resolves through this table, always.
CREATE TABLE variant_barcodes (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  variant_id   uuid NOT NULL,
  barcode      text NOT NULL,
  kind         text NOT NULL DEFAULT 'upc',     -- upc | ean | case | vendor | internal
  units        numeric(14,3) NOT NULL DEFAULT 1, -- a case barcode adds 12, not 1
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  CONSTRAINT barcode_units_positive CHECK (units > 0)
);
-- One barcode resolves to exactly one variant per organization. This is the
-- constraint that prevents the single most common catalog data disaster.
CREATE UNIQUE INDEX barcodes_org_code_key ON variant_barcodes (org_id, barcode);
CREATE UNIQUE INDEX barcodes_primary_key  ON variant_barcodes (variant_id) WHERE is_primary;
CREATE INDEX barcodes_variant_idx ON variant_barcodes (variant_id);

-- Effective dated prices, optionally per store. The register keeps the whole
-- future schedule locally so a scheduled price change applies on time even if
-- the terminal has been offline since yesterday.
CREATE TABLE variant_prices (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  variant_id     uuid NOT NULL,
  store_id       uuid,                    -- null = org default
  kind           price_kind NOT NULL DEFAULT 'regular',
  price_minor    money_minor NOT NULL CHECK (price_minor >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE CASCADE,
  CONSTRAINT variant_prices_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX variant_prices_lookup_idx
  ON variant_prices (org_id, variant_id, kind, store_id, effective_from DESC);
-- At most one open ended regular price per variant per store scope.
CREATE UNIQUE INDEX variant_prices_open_regular_key
  ON variant_prices (variant_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind = 'regular' AND effective_to IS NULL;

-- Per store channel availability. Separate from compliance rules: this is what
-- the OWNER wants, compliance is what the LAW allows. Both must say yes.
CREATE TABLE variant_store_settings (
  org_id            uuid NOT NULL,
  variant_id        uuid NOT NULL,
  store_id          uuid NOT NULL,
  sellable_in_store boolean NOT NULL DEFAULT true,
  listed_online     boolean NOT NULL DEFAULT false,
  pickup_enabled    boolean NOT NULL DEFAULT false,
  delivery_enabled  boolean NOT NULL DEFAULT false,
  shelf_location    text,
  bin               text,
  reorder_point     numeric(14,3),
  reorder_quantity  numeric(14,3),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, store_id),
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE CASCADE
);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id     uuid NOT NULL,
  product_id uuid,
  variant_id uuid,
  url        text NOT NULL,
  thumb_url  text,
  alt_text   text,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, org_id) REFERENCES products (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  CONSTRAINT product_images_target CHECK (product_id IS NOT NULL OR variant_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- Vendors
-- -----------------------------------------------------------------------------

CREATE TABLE vendors (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code                   text NOT NULL,
  name                   text NOT NULL,
  contact_name           text,
  sales_rep_name         text,
  sales_rep_phone        text,
  sales_rep_email        text,
  phone                  text,
  email                  text,
  website                text,
  address_line1          text,
  address_line2          text,
  city                   text,
  region                 text,
  postal_code            text,
  country                char(2) NOT NULL DEFAULT 'US',
  payment_terms          text,                       -- 'NET30', 'COD'
  lead_time_days         smallint NOT NULL DEFAULT 7 CHECK (lead_time_days >= 0),
  minimum_order_minor    money_minor NOT NULL DEFAULT 0,
  free_shipping_threshold_minor money_minor,
  -- EDI configuration is stored as jsonb because every trading partner differs.
  -- See docs/INTEGRATIONS.md. Credentials live in the secret manager, keyed by
  -- edi_config->>'credential_ref', never inline here.
  edi_enabled            boolean NOT NULL DEFAULT false,
  edi_config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                  text,
  status                 entity_status NOT NULL DEFAULT 'active',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX vendors_org_code_key ON vendors (org_id, upper(code));
CREATE TRIGGER vendors_touch BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE vendor_variants (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id          uuid NOT NULL,
  vendor_id       uuid NOT NULL,
  variant_id      uuid NOT NULL,
  vendor_sku      text NOT NULL,
  vendor_barcode  text,
  case_quantity   integer NOT NULL DEFAULT 1 CHECK (case_quantity > 0),
  case_cost       numeric(14,6) NOT NULL DEFAULT 0 CHECK (case_cost >= 0),
  unit_cost       numeric(14,6) GENERATED ALWAYS AS (case_cost / case_quantity) STORED,
  is_preferred    boolean NOT NULL DEFAULT false,
  last_ordered_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vendor_id, org_id)  REFERENCES vendors (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  UNIQUE (vendor_id, vendor_sku)
);
CREATE UNIQUE INDEX vendor_variants_preferred_key ON vendor_variants (variant_id) WHERE is_preferred;
CREATE INDEX vendor_variants_variant_idx ON vendor_variants (variant_id);

-- -----------------------------------------------------------------------------
-- Compliance
--
-- Rules are DATA with effective dates, never code. Texas hemp rules changed
-- three times in twelve months and the federal hemp redefinition lands
-- 2026-11-12. An owner must be able to pull a whole category off sale at 11pm
-- on a Tuesday without a deploy. See docs/COMPLIANCE.md.
-- -----------------------------------------------------------------------------

-- Product level intrinsic facts. What the item IS.
CREATE TABLE product_compliance (
  org_id             uuid NOT NULL,
  product_id         uuid NOT NULL PRIMARY KEY,
  minimum_age        smallint CHECK (minimum_age IS NULL OR minimum_age BETWEEN 0 AND 99),
  id_scan_required   boolean NOT NULL DEFAULT false,
  regulated_class    text,        -- 'ends' | 'tobacco' | 'consumable_hemp' | 'kratom' | null
  contains_nicotine  boolean NOT NULL DEFAULT false,
  contains_cannabinoid boolean NOT NULL DEFAULT false,
  is_smokable        boolean NOT NULL DEFAULT false,
  coa_url            text,        -- certificate of analysis, required for hemp
  coa_expires_at     date,
  notes              text,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (product_id, org_id) REFERENCES products (id, org_id) ON DELETE CASCADE
);
CREATE INDEX product_compliance_class_idx ON product_compliance (org_id, regulated_class);
CREATE INDEX product_compliance_coa_idx   ON product_compliance (coa_expires_at)
  WHERE coa_expires_at IS NOT NULL;

-- Jurisdiction rules. What the LAW allows, where, when, through which channel.
CREATE TABLE compliance_rules (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = platform default
  name           text NOT NULL,
  priority       smallint NOT NULL DEFAULT 100,

  -- Scope. More specific scope wins. Null means "any".
  scope_country  char(2),
  scope_region   text,
  scope_county   text,
  scope_city     text,
  scope_store_id uuid,

  -- Subject. Matched against the product, its category path or its attributes.
  subject_category_path_prefix text,      -- 'vapes.' matches the whole subtree
  subject_regulated_class      text,
  subject_product_id           uuid,
  subject_variant_id           uuid,
  subject_match                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- attribute predicate

  channel        compliance_channel,      -- null = every channel
  effect         compliance_effect NOT NULL,
  effect_age     smallint,                -- with effect = require_age
  overridable    boolean NOT NULL DEFAULT false,
  deny_message   text,                    -- shown to the cashier verbatim

  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,

  -- Why this rule exists. An auditor will ask.
  authority_note text,
  source_url     text,
  reviewed_by    text,
  reviewed_at    date,

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_age_present
    CHECK (effect <> 'require_age' OR effect_age IS NOT NULL),
  CONSTRAINT compliance_window
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX compliance_rules_lookup_idx
  ON compliance_rules (org_id, channel, effective_from DESC)
  WHERE effective_to IS NULL;
CREATE INDEX compliance_rules_scope_idx
  ON compliance_rules (scope_country, scope_region, scope_city);
CREATE INDEX compliance_rules_category_idx
  ON compliance_rules (subject_category_path_prefix text_pattern_ops);
CREATE TRIGGER compliance_rules_touch BEFORE UPDATE ON compliance_rules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Platform baseline. These are starting points that a licensed attorney must
-- review before go live. They are intentionally conservative: the engine fails
-- closed, so an unreviewed rule set blocks sales rather than permitting them.
INSERT INTO compliance_rules
  (org_id, name, priority, scope_country, subject_regulated_class, channel, effect, effect_age,
   deny_message, authority_note)
VALUES
  (NULL, 'Federal Tobacco 21 (tobacco)', 10, 'US', 'tobacco', NULL, 'require_age', 21,
   'Customer must be 21 or older.',
   'Federal minimum age of sale for tobacco products is 21. Verify current text with counsel.'),
  (NULL, 'Federal Tobacco 21 (ENDS)', 10, 'US', 'ends', NULL, 'require_age', 21,
   'Customer must be 21 or older.',
   'ENDS are covered by the federal 21 minimum. Verify current text with counsel.'),
  (NULL, 'ID scan for ENDS', 20, 'US', 'ends', 'in_store', 'require_id_scan', NULL,
   'Photo ID must be scanned for this item.', 'Retailer policy baseline.'),
  (NULL, 'Consumable hemp 21+ (TX)', 10, 'US', 'consumable_hemp', NULL, 'require_age', 21,
   'Customer must be 21 or older.',
   'TX 35 TAC 35.5 / 35.6 effective 2026-01-21 require 21+ with government issued ID for consumable hemp. CONFIRM CURRENT TEXT WITH COUNSEL.'),
  (NULL, 'Consumable hemp ID scan (TX)', 20, 'US', 'consumable_hemp', 'in_store', 'require_id_scan', NULL,
   'Government issued ID must be verified for this item.',
   'TX rules require verification with government issued identification. CONFIRM WITH COUNSEL.'),
  (NULL, 'No shipping of ENDS', 5, 'US', 'ends', 'ship', 'deny', NULL,
   'This item cannot be shipped.',
   'PACT Act bars USPS carriage of ENDS and imposes delivery seller registration and monthly state reporting on interstate delivery sales. Do not enable without counsel.'),
  (NULL, 'Delivery of ENDS requires review', 5, 'US', 'ends', 'delivery', 'deny', NULL,
   'This item is not available for delivery.',
   'ATF guidance treats a remote order of ENDS as a delivery sale whether shipped by carrier or by the seller''s own vehicle. Texas requires an e-cigarette retailer permit covering delivery sales. Counsel review required before enabling.');

-- -----------------------------------------------------------------------------
-- Search support: one denormalized row per variant, maintained by the
-- application on write. Trigram GIN answers fuzzy SKU and name search in a few
-- milliseconds at this catalog size, which is why there is no search cluster.
-- -----------------------------------------------------------------------------

CREATE TABLE variant_search (
  variant_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  haystack     text NOT NULL,       -- name, brand, sku, plu, barcodes, category, vendor sku
  tsv          tsvector,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE
);
CREATE INDEX variant_search_tsv_idx ON variant_search USING gin (tsv);
CREATE INDEX variant_search_org_idx ON variant_search (org_id);

-- Trigram fuzzy matching is what makes "geekbar mimi mint" find the right SKU.
-- Some managed hosts require the extension to be allowlisted first, so this
-- degrades to tsvector only rather than failing the migration. CI asserts the
-- index exists in staging and production.
DO $trgm$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX variant_search_trgm_idx ON variant_search USING gin (haystack gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm unavailable (%); fuzzy product search degraded to tsvector only', SQLERRM;
END $trgm$;
