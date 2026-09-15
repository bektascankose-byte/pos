-- =============================================================================
-- 0016_case_costing.sql
--
-- Case based costing: the numbers actually printed on a vendor invoice.
--
-- A shop buys a case and sells a unit. Until now a variant carried only its
-- unit `cost`, so somebody had to do the division by hand every time an
-- invoice arrived, and the arithmetic behind a retail price was nowhere on
-- file -- which is also why margin appears nowhere in the app. These four
-- columns are the inputs that produce a unit cost:
--
--   cost/unit after discount = (case_cost - case_discount) / case_quantity
--
-- `cost` stays the single source of truth for what a unit costs, derived from
-- these when they're set (see CatalogService.updateVariant) and entered
-- directly when they aren't -- an item bought by the each has no case.
--
-- A rebate is deliberately NOT part of that: it arrives after the fact from
-- the manufacturer, so it belongs in the margin the owner reasons about
-- ("margin after rebate") without rewriting the cost that inventory is
-- actually valued at.
--
-- numeric(14,6) matches `cost` itself, for the reason its own comment in 0002
-- gives: a case of 12 at $5.00 is 0.416667 a unit and cents would corrupt
-- margin within weeks.
-- =============================================================================

ALTER TABLE product_variants
  ADD COLUMN case_cost      numeric(14,6) CHECK (case_cost >= 0),
  ADD COLUMN case_discount  numeric(14,6) NOT NULL DEFAULT 0 CHECK (case_discount >= 0),
  ADD COLUMN case_rebate    numeric(14,6) NOT NULL DEFAULT 0 CHECK (case_rebate >= 0),
  -- Target margin as a percentage, for suggesting a retail price. Under 100
  -- because margin is taken on the retail price: at 100% the price is
  -- infinite, and above it the arithmetic has no meaning.
  ADD COLUMN default_margin numeric(5,2) CHECK (default_margin >= 0 AND default_margin < 100);

-- A discount can't exceed what the case cost in the first place.
ALTER TABLE product_variants
  ADD CONSTRAINT case_discount_within_cost
  CHECK (case_cost IS NULL OR case_discount <= case_cost);
