-- =============================================================================
-- 0022_invoice_payment_terms.sql
--
-- What an invoice says about money and dates, not just about goods.
--
-- `invoice_imports` recorded a grand total and nothing else, so the questions
-- a shop owner actually asks of a pile of invoices -- what did I spend last
-- month, what is still owed, which vendor takes the most -- could not be
-- answered from this table at all. The documents carry every one of those
-- facts in print; there was simply nowhere to put them.
--
-- All of it is what the DOCUMENT claimed, extracted for reporting. None of it
-- is an accounts-payable ledger: nothing here is double-entry, nothing
-- reconciles against a bank feed, and a payment recorded on a vendor's PDF is
-- that vendor's word for it. Reports built on these columns should say
-- "invoiced" and "per the invoice", never "paid" as an accounting fact.
-- =============================================================================

ALTER TABLE invoice_imports
  -- The date the vendor put on the invoice, which is the date the spend
  -- belongs to. Deliberately not `created_at`: an invoice uploaded in
  -- November for goods delivered in September is September's cost, and
  -- reporting it in November would misstate both months.
  ADD COLUMN invoice_date       date,
  ADD COLUMN due_date           date,
  -- What the document says has already been paid against it, and what it says
  -- is still outstanding. Stored rather than derived because an invoice can
  -- show a credit note or a rounding the two totals don't reconcile to, and
  -- silently computing a different number than the paper says is how nobody
  -- trusts the report again.
  ADD COLUMN amount_paid_minor  money_minor,
  ADD COLUMN shipping_minor     money_minor,
  ADD COLUMN discount_minor     money_minor,
  -- "Credit Note on Account", "ACH", "Visa ending 4412" -- free text, because
  -- every vendor words it differently and none of it drives behaviour.
  ADD COLUMN payment_method     text,
  ADD COLUMN payment_terms      text;

-- Reporting reads spend by date across a range; the partial index keeps that
-- off the rows that have no date to report against.
CREATE INDEX invoice_imports_invoice_date_idx
  ON invoice_imports (org_id, invoice_date)
  WHERE invoice_date IS NOT NULL;
