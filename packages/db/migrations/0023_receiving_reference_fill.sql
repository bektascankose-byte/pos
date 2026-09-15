-- =============================================================================
-- 0023_receiving_reference_fill.sql
--
-- Which received lines named themselves.
--
-- Scanning a code the catalog has never seen used to stop the count: the line
-- sat unresolved until somebody opened a dialog and typed a name. With the
-- old system's item file loaded (see 0020), most of those codes are already
-- known -- name, price, cost and department -- so the scan can fill itself in
-- and the count can keep moving.
--
-- That convenience creates an obligation. A price carried over from another
-- system is the price it had THERE, on the day that file was exported, and an
-- item created this way is sellable at that price the moment stock lands on
-- it. So the fact is recorded per line rather than inferred, and the screen
-- says plainly which lines named themselves and which a human named.
--
-- Deliberately on the line and not the product: it describes how this
-- particular scan was resolved, which is a fact about the count. The product
-- it created is an ordinary product from that point on.
-- =============================================================================

ALTER TABLE receiving_lines
  ADD COLUMN filled_from_reference boolean NOT NULL DEFAULT false;
