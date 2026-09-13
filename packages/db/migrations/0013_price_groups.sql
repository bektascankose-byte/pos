-- =============================================================================
-- 0013_price_groups.sql
--
-- Price groups: several variants -- possibly across different products --
-- priced together, so "change their price later, all at once" doesn't mean
-- re-selecting every member by hand. A group is formed by pricing a set of
-- variants together for the first time (see CatalogService.bulkSetPrice),
-- not declared ahead of time as an empty container.
--
-- No touch trigger: a price group's own row is never edited in place, the
-- same as purchase_order_lines having no updated_at. No new permission --
-- reuses product.update, the same gate a single variant's price already
-- sits behind.
-- =============================================================================

CREATE TABLE price_groups (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

ALTER TABLE product_variants
  ADD COLUMN price_group_id uuid REFERENCES price_groups(id) ON DELETE SET NULL;

CREATE INDEX variants_price_group_idx ON product_variants (price_group_id)
  WHERE price_group_id IS NOT NULL;

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE price_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON price_groups
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
