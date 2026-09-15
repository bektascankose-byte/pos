-- =============================================================================
-- 0021_invoice_line_barcode.sql
--
-- What the invoice said this item's barcode was.
--
-- `invoice_import_lines` could record a vendor's own SKU but had nowhere to
-- put a UPC, so the AI extraction had no field to return one in and simply
-- dropped it. That is the strongest identifier an invoice can carry: a vendor
-- SKU means something only to that vendor, while a UPC identifies the product
-- to the whole world and matches this catalog exactly. Invoices that printed
-- a Barcode column and no SKU column -- which is common -- therefore arrived
-- with nothing matchable on them at all.
--
-- A suggestion like every other `parsed_` column here: it records what the
-- document appeared to say, and a human reviewing the line is still what
-- decides whether any of it reaches a real catalog row.
-- =============================================================================

ALTER TABLE invoice_import_lines ADD COLUMN parsed_barcode text;

-- Matching reads this column for every unresolved line on an import, so it is
-- worth an index even though the table is small: the alternative is a scan
-- per line, per run.
CREATE INDEX invoice_lines_parsed_barcode_idx
  ON invoice_import_lines (org_id, parsed_barcode)
  WHERE parsed_barcode IS NOT NULL;
