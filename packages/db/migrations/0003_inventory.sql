-- =============================================================================
-- 0003_inventory.sql
-- The ledger is the truth. inventory_levels is a projection.
--
-- Both are written in the SAME transaction, always, through one repository
-- method that is the only code in the system permitted to touch
-- inventory_levels. A nightly job recomputes sum(delta) per store per variant
-- and reports drift. Drift only ever appears when something bypassed the
-- repository, which is exactly what the job exists to catch.
-- =============================================================================

CREATE TYPE inventory_reason AS ENUM (
  'opening_balance',
  'sale',
  'refund',
  'receiving',
  'transfer_in',
  'transfer_out',
  'count_adjustment',
  'damage',
  'expired',
  'theft',
  'vendor_return',
  'promo_giveaway',
  'online_order',
  'online_cancel',
  'manual_adjustment',
  'recall'              -- a regulatory change can force stock off the shelf
);

CREATE TYPE reservation_state AS ENUM ('held', 'committed', 'released', 'expired');
CREATE TYPE count_mode        AS ENUM ('full', 'cycle', 'spot', 'category', 'vendor');
CREATE TYPE count_status      AS ENUM ('draft', 'counting', 'review', 'posted', 'cancelled');
CREATE TYPE transfer_status   AS ENUM ('requested', 'approved', 'packed', 'in_transit', 'received', 'cancelled');
CREATE TYPE po_status         AS ENUM ('draft', 'submitted', 'confirmed', 'partial', 'received', 'closed', 'cancelled');

-- -----------------------------------------------------------------------------
-- Levels: the fast projection the register and storefront read.
-- -----------------------------------------------------------------------------

CREATE TABLE inventory_levels (
  org_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  variant_id    uuid NOT NULL,
  on_hand       numeric(14,3) NOT NULL DEFAULT 0,
  reserved      numeric(14,3) NOT NULL DEFAULT 0,
  available     numeric(14,3) GENERATED ALWAYS AS (on_hand - reserved) STORED,
  last_counted_at   timestamptz,
  last_received_at  timestamptz,
  last_sold_at      timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, variant_id),
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  -- on_hand CAN go negative: two offline registers selling the last unit both
  -- succeed, and refusing the second record would not un-sell the product. It
  -- raises a NegativeInventory alert instead. reserved never goes negative.
  CONSTRAINT inventory_reserved_nonneg CHECK (reserved >= 0)
);
CREATE INDEX inventory_levels_variant_idx  ON inventory_levels (variant_id);
CREATE INDEX inventory_levels_negative_idx ON inventory_levels (store_id) WHERE on_hand < 0;
CREATE INDEX inventory_levels_zero_idx     ON inventory_levels (store_id) WHERE on_hand <= 0;

-- -----------------------------------------------------------------------------
-- Ledger: append only, partitioned monthly. Nothing changes stock without
-- writing one of these rows.
-- -----------------------------------------------------------------------------

-- IDEMPOTENCY CONVENTION (load bearing, do not "simplify" this away):
--
-- For any movement derived from a document line, the ledger row's id IS the
-- source line's id, and occurred_at IS the source document's business
-- timestamp. Both are therefore deterministic on replay:
--
--   sale line      -> id = sale_line.id,        occurred_at = sale.completed_at
--   refund line    -> id = refund_line.id,      occurred_at = refund.completed_at
--   receipt line   -> id = po_receipt_line.id,  occurred_at = po_receipt.received_at
--   count line     -> id = count_line.id,       occurred_at = count.posted_at
--   transfer line  -> id = transfer_line.id,    occurred_at = transfer.received_at
--
-- Intake then writes INSERT ... ON CONFLICT (id, occurred_at) DO NOTHING and a
-- replayed sync batch cannot double count stock. This makes correctness a
-- property of the schema rather than a property of someone remembering to write
-- the intake handler the right way.
--
-- Movements with no source line (manual adjustments, opening balances) fall
-- back to a fresh UUIDv7 and are idempotent at the API layer instead.
CREATE TABLE inventory_ledger (
  id             uuid NOT NULL DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  store_id       uuid NOT NULL,
  variant_id     uuid NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  delta          numeric(14,3) NOT NULL,
  reason         inventory_reason NOT NULL,
  unit_cost      numeric(14,6),           -- cost at the moment of movement
  reference_type text,                    -- 'sale' | 'purchase_order' | 'count' | 'transfer'
  reference_id   uuid,
  actor_user_id  uuid,
  device_id      uuid,
  note           text,
  -- Set only by the reconciliation job, for fast integrity checks. Not relied
  -- on for correctness: sum(delta) is always authoritative.
  balance_after  numeric(14,3),
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT ledger_delta_nonzero CHECK (delta <> 0)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ledger_variant_time_idx ON inventory_ledger (store_id, variant_id, occurred_at DESC);
CREATE INDEX ledger_org_time_idx     ON inventory_ledger (org_id, occurred_at DESC);
CREATE INDEX ledger_reference_idx    ON inventory_ledger (reference_type, reference_id);
CREATE INDEX ledger_reason_idx       ON inventory_ledger (org_id, reason, occurred_at DESC);
-- Manual adjustments are the loss prevention signal, so they get their own index.
CREATE INDEX ledger_manual_idx       ON inventory_ledger (org_id, actor_user_id, occurred_at DESC)
  WHERE reason IN ('manual_adjustment', 'damage', 'theft', 'count_adjustment');

SELECT ensure_monthly_partitions('inventory_ledger', (date_trunc('month', now()) - interval '1 month')::date, 14);

-- -----------------------------------------------------------------------------
-- Reservations. Online checkout holds stock for 15 minutes; a sweeper releases
-- expired holds every 60 seconds. In store sales do NOT reserve, they decrement
-- directly, because the product is physically leaving the counter.
-- -----------------------------------------------------------------------------

CREATE TABLE inventory_reservations (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  store_id       uuid NOT NULL,
  variant_id     uuid NOT NULL,
  quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
  state          reservation_state NOT NULL DEFAULT 'held',
  reason         text NOT NULL DEFAULT 'online_order',
  reference_type text,
  reference_id   uuid,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  CONSTRAINT reservation_resolved CHECK (
    (state IN ('held')) = (resolved_at IS NULL)
  )
);
CREATE INDEX reservations_active_idx ON inventory_reservations (store_id, variant_id) WHERE state = 'held';
CREATE INDEX reservations_expiry_idx ON inventory_reservations (expires_at)           WHERE state = 'held';
CREATE INDEX reservations_ref_idx    ON inventory_reservations (reference_type, reference_id);

-- -----------------------------------------------------------------------------
-- Cost layers. Weighted average cost is what reports use on day one, but every
-- receipt writes a layer anyway. Switching to FIFO later without these requires
-- reconstructing history that no longer exists. Cost: one small insert per
-- receipt line. Benefit: a costing model change whenever you want one.
-- -----------------------------------------------------------------------------

CREATE TABLE cost_layers (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  variant_id    uuid NOT NULL,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  remaining     numeric(14,3) NOT NULL CHECK (remaining >= 0),
  unit_cost     numeric(14,6) NOT NULL CHECK (unit_cost >= 0),
  source_type   text NOT NULL,           -- 'receiving' | 'transfer_in' | 'opening_balance'
  source_id     uuid,
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  CONSTRAINT cost_layer_remaining CHECK (remaining <= quantity)
);
CREATE INDEX cost_layers_fifo_idx ON cost_layers (store_id, variant_id, received_at)
  WHERE remaining > 0;

-- -----------------------------------------------------------------------------
-- Counts. Each line snapshots the expected quantity at the moment the LINE is
-- created, not at post time, so a sale during the count does not silently
-- become a variance.
-- -----------------------------------------------------------------------------

CREATE TABLE inventory_counts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  reference     text NOT NULL,
  mode          count_mode NOT NULL,
  status        count_status NOT NULL DEFAULT 'draft',
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- category ids, vendor id, etc
  blind         boolean NOT NULL DEFAULT true,       -- hide expected qty from the counter
  started_by    uuid,
  started_at    timestamptz,
  posted_by     uuid,
  posted_at     timestamptz,
  cancelled_at  timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX inventory_counts_ref_key ON inventory_counts (org_id, reference);
CREATE INDEX inventory_counts_open_idx ON inventory_counts (store_id)
  WHERE status IN ('draft', 'counting', 'review');

CREATE TABLE inventory_count_lines (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL,
  count_id          uuid NOT NULL,
  variant_id        uuid NOT NULL,
  expected_quantity numeric(14,3) NOT NULL,          -- snapshot at line creation
  expected_at       timestamptz NOT NULL DEFAULT now(),
  counted_quantity  numeric(14,3),
  variance          numeric(14,3) GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,
  unit_cost         numeric(14,6) NOT NULL DEFAULT 0,
  unit_price_minor  money_minor NOT NULL DEFAULT 0,
  counted_by        uuid,
  counted_at        timestamptz,
  recount_of        uuid,
  reason_code       text,
  note              text,
  FOREIGN KEY (count_id, org_id)   REFERENCES inventory_counts (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  UNIQUE (count_id, variant_id)
);
CREATE INDEX count_lines_variance_idx ON inventory_count_lines (count_id)
  WHERE counted_quantity IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Transfers
-- -----------------------------------------------------------------------------

CREATE TABLE inventory_transfers (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  reference      text NOT NULL,
  from_store_id  uuid NOT NULL,
  to_store_id    uuid NOT NULL,
  status         transfer_status NOT NULL DEFAULT 'requested',
  requested_by   uuid, requested_at  timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid, approved_at   timestamptz,
  packed_by      uuid, packed_at     timestamptz,
  shipped_at     timestamptz,
  received_by    uuid, received_at   timestamptz,
  cancelled_by   uuid, cancelled_at  timestamptz,
  note           text,
  FOREIGN KEY (from_store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT transfer_distinct_stores CHECK (from_store_id <> to_store_id),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX transfers_ref_key ON inventory_transfers (org_id, reference);

CREATE TABLE inventory_transfer_lines (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id             uuid NOT NULL,
  transfer_id        uuid NOT NULL,
  variant_id         uuid NOT NULL,
  quantity_requested numeric(14,3) NOT NULL CHECK (quantity_requested > 0),
  quantity_packed    numeric(14,3),
  quantity_received  numeric(14,3),
  unit_cost          numeric(14,6) NOT NULL DEFAULT 0,
  FOREIGN KEY (transfer_id, org_id) REFERENCES inventory_transfers (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id)  REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  UNIQUE (transfer_id, variant_id)
);

-- -----------------------------------------------------------------------------
-- Purchase orders
-- -----------------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL,
  store_id          uuid NOT NULL,
  vendor_id         uuid NOT NULL,
  reference         text NOT NULL,
  status            po_status NOT NULL DEFAULT 'draft',
  expected_at       date,
  vendor_invoice_no text,
  subtotal_minor    money_minor NOT NULL DEFAULT 0,
  shipping_minor    money_minor NOT NULL DEFAULT 0,
  tax_minor         money_minor NOT NULL DEFAULT 0,
  total_minor       money_minor NOT NULL DEFAULT 0,
  -- Provenance: was this PO generated by the forecaster or typed by a human?
  source            text NOT NULL DEFAULT 'manual',   -- manual | reorder | edi
  edi_document_id   uuid,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz,
  confirmed_at      timestamptz,
  closed_at         timestamptz,
  cancelled_at      timestamptz,
  note              text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id)  REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (vendor_id, org_id) REFERENCES vendors (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX po_ref_key   ON purchase_orders (org_id, reference);
CREATE INDEX po_open_idx         ON purchase_orders (store_id, status)
  WHERE status IN ('draft', 'submitted', 'confirmed', 'partial');
CREATE INDEX po_vendor_idx       ON purchase_orders (vendor_id, created_at DESC);
CREATE TRIGGER po_touch BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id             uuid NOT NULL,
  purchase_order_id  uuid NOT NULL,
  variant_id         uuid NOT NULL,
  vendor_sku         text,
  quantity_ordered   numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received  numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  case_quantity      integer NOT NULL DEFAULT 1 CHECK (case_quantity > 0),
  unit_cost          numeric(14,6) NOT NULL CHECK (unit_cost >= 0),
  line_total_minor   money_minor NOT NULL DEFAULT 0,
  note               text,
  FOREIGN KEY (purchase_order_id, org_id) REFERENCES purchase_orders (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id)        REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  UNIQUE (purchase_order_id, variant_id)
);
CREATE INDEX po_lines_variant_idx ON purchase_order_lines (variant_id);

-- A receipt event. Partial receiving is normal, so a PO can have many.
CREATE TABLE po_receipts (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  received_by       uuid,
  received_at       timestamptz NOT NULL DEFAULT now(),
  vendor_invoice_no text,
  invoice_total_minor money_minor,
  -- Set when the vendor invoice disagrees with the PO. A real and frequent
  -- event that the system must surface rather than silently absorb.
  variance_flagged  boolean NOT NULL DEFAULT false,
  variance_note     text,
  document_url      text,                -- scanned invoice in object storage
  FOREIGN KEY (purchase_order_id, org_id) REFERENCES purchase_orders (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);
CREATE INDEX po_receipts_po_idx ON po_receipts (purchase_order_id, received_at);

CREATE TABLE po_receipt_lines (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL,
  receipt_id        uuid NOT NULL,
  po_line_id        uuid NOT NULL,
  variant_id        uuid NOT NULL,
  quantity_received numeric(14,3) NOT NULL CHECK (quantity_received > 0),
  unit_cost         numeric(14,6) NOT NULL CHECK (unit_cost >= 0),  -- can differ from PO
  cost_changed      boolean NOT NULL DEFAULT false,
  FOREIGN KEY (receipt_id, org_id) REFERENCES po_receipts (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines (id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX po_receipt_lines_receipt_idx ON po_receipt_lines (receipt_id);

-- -----------------------------------------------------------------------------
-- Forecasting output. Written nightly, read by the purchase order builder.
-- Every parameter behind these numbers is a per org, per category or per vendor
-- setting. Owner overrides are recorded, which produces labeled training data
-- for free if a model is ever worth adding.
-- -----------------------------------------------------------------------------

CREATE TABLE reorder_recommendations (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id              uuid NOT NULL,
  store_id            uuid NOT NULL,
  variant_id          uuid NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  method              text NOT NULL,          -- 'ses' | 'croston' | 'seasonal_naive'
  avg_daily_sales     numeric(12,4) NOT NULL,
  demand_stddev       numeric(12,4) NOT NULL DEFAULT 0,
  window_days         smallint NOT NULL,
  stockout_days_excluded smallint NOT NULL DEFAULT 0,
  on_hand             numeric(14,3) NOT NULL,
  available           numeric(14,3) NOT NULL,
  lead_time_days      smallint NOT NULL,
  safety_stock        numeric(14,3) NOT NULL,
  reorder_point       numeric(14,3) NOT NULL,
  days_of_supply      numeric(10,2),
  projected_stockout_on date,
  recommended_quantity numeric(14,3) NOT NULL,
  recommended_vendor_id uuid,
  urgency             text NOT NULL DEFAULT 'normal',  -- now | soon | normal | overstock
  accepted_at         timestamptz,
  accepted_by         uuid,
  overridden_quantity numeric(14,3),
  dismissed_at        timestamptz,
  FOREIGN KEY (store_id, org_id)   REFERENCES stores (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX reorder_current_key ON reorder_recommendations (store_id, variant_id, computed_at);
CREATE INDEX reorder_open_idx ON reorder_recommendations (store_id, urgency, computed_at DESC)
  WHERE accepted_at IS NULL AND dismissed_at IS NULL;

CREATE TABLE stock_alerts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  variant_id    uuid,
  kind          text NOT NULL,     -- low_stock | out_of_stock | negative | overstock
                                   -- dead_stock | fast_mover | unusual_loss
  severity      text NOT NULL DEFAULT 'info',
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at   timestamptz,
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE CASCADE
);
CREATE INDEX stock_alerts_open_idx ON stock_alerts (store_id, kind, raised_at DESC)
  WHERE resolved_at IS NULL;
