-- =============================================================================
-- 0025_storefront_availability.sql
--
-- What the website is allowed to sell, and how much of it.
--
-- The POS stays the authority on everything a product IS -- name, price, cost,
-- stock, tax, compliance. This table holds only the handful of facts that are
-- true of a product *online* and nowhere else, keyed by the variant's own id
-- so there is no second catalog to keep in step.
--
-- ONE ROW PER VARIANT, CREATED ON DEMAND. A variant with no row here is simply
-- not listed, which is why the default is `hidden` rather than something more
-- convenient: a shop that imports 8,000 items should not discover it has
-- published 8,000 items. Listing is a decision somebody makes.
--
-- WHY SAFETY STOCK CARRIES MORE WEIGHT HERE THAN IT NORMALLY WOULD. Pickup
-- orders do not hold inventory in this build -- a deliberate choice, because
-- holding stock for an order that may never be collected costs a small shop
-- the walk-in sale it could have made instead. The consequence is that the
-- counter can sell the last unit between an online order and its collection.
-- `safety_stock` is what absorbs that: a buffer of 2 means the website stops
-- offering an item while two are still on the shelf, so the race is lost by
-- the website rather than by a customer who has already paid.
--
-- Holds are not gone, only off by default. `hold_stock` is per fulfilment type
-- because delivery is a different bet: once a courier is dispatched the goods
-- genuinely leave, and `inventory_reservations` (waiting since 0003) is there
-- for it. Turning that on is a row, not a release.
-- =============================================================================

CREATE TYPE online_availability AS ENUM (
  'hidden',               -- not listed at all
  'pickup_only',
  'delivery_only',
  'pickup_and_delivery'
);

CREATE TABLE storefront_listings (
  variant_id     uuid NOT NULL,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  availability   online_availability NOT NULL DEFAULT 'hidden',

  -- Units held back from the website. See the header: with no reservation on a
  -- pickup order this is the whole of the overselling protection.
  safety_stock   numeric(14,3) NOT NULL DEFAULT 0,

  -- Most a single order may contain, for purchase limits that are legal
  -- obligations in some categories rather than merchandising preferences.
  max_per_order  numeric(14,3),

  -- NULL means "whatever the POS charges", which is the answer that keeps the
  -- register and the website from disagreeing at the counter. A number here is
  -- a deliberate online-only price and is shown as such in the back office.
  online_price_minor money_minor,

  -- Whether an order of this item should hold stock, by fulfilment type.
  -- Both default false: see the header.
  hold_for_pickup   boolean NOT NULL DEFAULT false,
  hold_for_delivery boolean NOT NULL DEFAULT false,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,

  PRIMARY KEY (variant_id),
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  UNIQUE (variant_id, org_id),
  CONSTRAINT listing_safety_stock_nonneg CHECK (safety_stock >= 0),
  CONSTRAINT listing_max_per_order_positive CHECK (max_per_order IS NULL OR max_per_order > 0),
  CONSTRAINT listing_online_price_nonneg CHECK (online_price_minor IS NULL OR online_price_minor >= 0)
);

-- The storefront's own listing query: everything sellable online, by kind.
CREATE INDEX storefront_listings_available_idx
  ON storefront_listings (org_id, availability)
  WHERE availability <> 'hidden';

CREATE TRIGGER storefront_listings_touch BEFORE UPDATE ON storefront_listings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- What the website may sell, as one expression the whole system agrees on.
--
-- A view rather than application code because three separate readers need the
-- same answer -- the storefront, the reconciliation job, and the back office's
-- discrepancy report -- and three implementations of a subtraction is how they
-- start disagreeing. `GREATEST(…, 0)` because on_hand is allowed to go
-- negative (two offline registers can both sell the last unit) and a negative
-- availability would read as a number rather than as "none".
-- -----------------------------------------------------------------------------

-- `security_invoker` is not optional here, it is the whole security boundary.
-- A Postgres view runs with its OWNER's rights by default, and the owner of
-- everything in this schema is the migrator role, which carries BYPASSRLS. So
-- without this, every caller reading through the view would see every
-- organization's rows -- the one tenant isolation hole a view can open that
-- the table underneath it cannot. Verified by test, not by assumption.
CREATE OR REPLACE VIEW storefront_availability
WITH (security_invoker = true) AS
SELECT
  l.variant_id,
  l.org_id,
  il.store_id,
  l.availability,
  COALESCE(il.on_hand, 0)                       AS on_hand,
  -- Only held reservations count. Committed ones have already left as ledger
  -- movements, and released ones never happened.
  COALESCE(r.held, 0)                           AS reserved,
  l.safety_stock,
  -- Cast so the wire format never varies: bare `0` and `0.000` are the same
  -- number but not the same string, and clients compare strings.
  GREATEST(COALESCE(il.on_hand, 0) - COALESCE(r.held, 0) - l.safety_stock, 0)::numeric(14,3) AS sellable
FROM storefront_listings l
JOIN inventory_levels il
  ON il.variant_id = l.variant_id
LEFT JOIN LATERAL (
  SELECT sum(res.quantity) AS held
  FROM inventory_reservations res
  WHERE res.variant_id = l.variant_id
    AND res.store_id = il.store_id
    AND res.state = 'held'
    AND res.expires_at > now()
) r ON true;

INSERT INTO permissions (key, category, description) VALUES
  ('storefront.view',   'storefront', 'View storefront listing settings'),
  ('storefront.manage', 'storefront', 'Change what is listed online, safety stock and online prices')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator')
  AND p.key IN ('storefront.view', 'storefront.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'storefront.view' FROM roles r
WHERE r.org_id IS NULL AND r.key = 'manager'
ON CONFLICT DO NOTHING;

ALTER TABLE storefront_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON storefront_listings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
