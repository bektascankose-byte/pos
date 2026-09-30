-- =============================================================================
-- 0035_price_group_members.sql
--
-- A flavor can now sit in more than one price group. Until now a variant
-- carried a single `price_group_id`, so adding it to a second group quietly
-- took it out of the first. The owner wants the opposite: every flavor of
-- Celsius Sparkling 12oz stays in the "Celsius Sparkling 12oz" group, and the
-- one flavor that is not selling can also go into a promotion group next to a
-- Monster flavor and a Fiji Water, priced at $1.99 there.
--
-- Which price wins when two groups disagree? Neither group does. A group has
-- no price of its own (0013 kept it that way on purpose): pricing a group
-- writes an ordinary effective dated price onto each member, the same row a
-- price typed on the item page writes. So a member's price is simply the last
-- one anyone set, by any route. Pricing the promotion moves only its members;
-- pricing the Celsius group later moves every Celsius flavor again, the one in
-- the promotion included.
--
-- `price_groups.product_id` marks the group made for one product's flavors,
-- which saving an AI draft creates. It is how a flavor added to that product
-- later joins the same group, and how drafting the item a second time finds
-- the group instead of making another. At most one such group per product.
--
-- Membership rows are deleted outright, never archived: a group is a saved
-- selection, not a record of anything sold (the same reasoning that already
-- lets a whole group be deleted). A flavor that was never sold can still be
-- deleted too, and its memberships go with it -- which is why the variant key
-- cascades. RESTRICT there would make the flavor delete path read a group
-- membership as history and archive the flavor instead.
-- =============================================================================

CREATE TABLE price_group_members (
  org_id          uuid NOT NULL,
  price_group_id  uuid NOT NULL,
  variant_id      uuid NOT NULL,
  added_by        uuid,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (price_group_id, variant_id),
  FOREIGN KEY (price_group_id, org_id) REFERENCES price_groups (id, org_id)     ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id)     REFERENCES product_variants (id, org_id) ON DELETE CASCADE
);
-- "Which groups is this flavor in" -- the catalog list asks it for every row.
CREATE INDEX price_group_members_variant_idx ON price_group_members (variant_id);

-- Every existing membership carries over, dated to when its group was made.
INSERT INTO price_group_members (org_id, price_group_id, variant_id, added_by, added_at)
SELECT v.org_id, v.price_group_id, v.id, g.created_by, g.created_at
FROM product_variants v
JOIN price_groups g ON g.id = v.price_group_id;

DROP INDEX variants_price_group_idx;
ALTER TABLE product_variants DROP COLUMN price_group_id;

ALTER TABLE price_groups
  ADD COLUMN product_id uuid,
  ADD FOREIGN KEY (product_id, org_id) REFERENCES products (id, org_id) ON DELETE SET NULL (product_id);
CREATE UNIQUE INDEX price_groups_product_key ON price_groups (product_id) WHERE product_id IS NOT NULL;

-- RLS, opted into by hand as every table after 0005 has to.
ALTER TABLE price_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON price_group_members
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
