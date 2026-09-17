-- =============================================================================
-- 0031_delivery.sql
--
-- Local delivery, by courier.
--
-- 0027 declared the delivery half of an order's life -- `courier_requested`,
-- `in_transit`, `delivery_failed`, `returned_to_store` -- and left it
-- unreachable. This is the data that half needs: where the order is going,
-- what the courier said about it, and the money taken before it left.
--
-- WHY PAYMENT COMES FIRST. A pickup order is paid for at the counter, by
-- someone standing in front of the goods. A delivery order is not: the goods
-- leave with a courier who does not take payment. So a delivery order is paid
-- online before it is placed -- authorized at checkout, captured only when the
-- courier hands it over, and released if it never gets there. `order_payments`
-- keeps that separate from `payments`, which belong to finished sales and may
-- not exist before one does.
--
-- WHAT IS KEPT ABOUT THE CUSTOMER'S ADDRESS. What a courier needs to find the
-- door and the person, for as long as the order needs it. Addresses and phone
-- numbers are read by the API's own screens and sent to the courier; they are
-- never written to application logs. The courier's name is kept as a first
-- name only.
--
-- SERVICES DO NOT HOLD STOCK. A delivery fee rings up on the sale as a line,
-- the way it would at a counter, so a sale's total stays the sum of its lines.
-- But a fee is not a thing on a shelf, and `track_inventory` is what stops
-- selling one from counting stock that never existed.
-- =============================================================================

ALTER TABLE products ADD COLUMN track_inventory boolean NOT NULL DEFAULT true;

-- -----------------------------------------------------------------------------
-- Where a store delivers, and on what terms.
-- -----------------------------------------------------------------------------

CREATE TABLE store_delivery_settings (
  store_id               uuid PRIMARY KEY,
  org_id                 uuid NOT NULL,
  enabled                boolean NOT NULL DEFAULT false,
  provider               text NOT NULL DEFAULT 'doordash',

  -- The delivery area, as ZIP codes. A list a shop owner can read and argue
  -- with, rather than a radius nobody can picture.
  postal_codes           text[] NOT NULL DEFAULT '{}',

  -- What the customer pays for delivery. What the courier charges the shop is
  -- a separate number, recorded on each delivery.
  fee_minor              money_minor NOT NULL DEFAULT 0,
  free_over_minor        money_minor,
  minimum_subtotal_minor money_minor NOT NULL DEFAULT 0,

  -- Delivery orders stop this long before closing, so the last one can still
  -- be packed and collected by a courier.
  last_order_minutes_before_close smallint NOT NULL DEFAULT 30,

  -- Read to the courier at the door of the shop.
  pickup_instructions    text,

  updated_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE CASCADE,
  CONSTRAINT delivery_postal_codes_format CHECK (
    array_to_string(postal_codes, ',') ~ '^([0-9]{5}(,[0-9]{5})*)?$'
  ),
  CONSTRAINT delivery_fee_nonneg       CHECK (fee_minor >= 0),
  CONSTRAINT delivery_free_over_nonneg CHECK (free_over_minor IS NULL OR free_over_minor >= 0),
  CONSTRAINT delivery_minimum_nonneg   CHECK (minimum_subtotal_minor >= 0),
  CONSTRAINT delivery_cutoff_range     CHECK (last_order_minutes_before_close BETWEEN 0 AND 240)
);

CREATE TRIGGER store_delivery_settings_touch BEFORE UPDATE ON store_delivery_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Where a delivery order is going, and what the courier has said about it.
-- -----------------------------------------------------------------------------

CREATE TABLE order_deliveries (
  order_id               uuid PRIMARY KEY,
  org_id                 uuid NOT NULL,
  -- 'doordash' for the real service, 'simulated' on a server without its
  -- credentials. Kept per delivery so the record says which one it was.
  provider               text NOT NULL,

  recipient_name         text NOT NULL,
  recipient_phone        text NOT NULL,
  address_line1          text NOT NULL,
  address_line2          text,
  city                   text NOT NULL,
  region                 text NOT NULL,
  postal_code            text NOT NULL,
  dropoff_instructions   text,

  -- The id this system gives the courier for the delivery, and the courier's
  -- own words for where it is. Null until a courier is requested.
  external_delivery_id   text,
  provider_status        text,
  tracking_url           text,
  support_reference      text,
  driver_first_name      text,

  -- What the courier charges the shop, which is not what the customer paid.
  courier_fee_minor      money_minor,

  requested_at           timestamptz,
  estimated_pickup_at    timestamptz,
  estimated_dropoff_at   timestamptz,
  picked_up_at           timestamptz,
  dropped_off_at         timestamptz,
  cancellation_reason    text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (order_id, org_id) REFERENCES orders (id, org_id) ON DELETE CASCADE,
  CONSTRAINT delivery_postal_code_format CHECK (postal_code ~ '^[0-9]{5}$'),
  CONSTRAINT delivery_phone_e164         CHECK (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT delivery_requested_has_id   CHECK (requested_at IS NULL OR external_delivery_id IS NOT NULL)
);

-- Unique across every organization: it is what an incoming courier webhook is
-- matched on, before anyone knows whose delivery it is.
CREATE UNIQUE INDEX order_deliveries_external_id_key ON order_deliveries (external_delivery_id)
  WHERE external_delivery_id IS NOT NULL;

CREATE TRIGGER order_deliveries_touch BEFORE UPDATE ON order_deliveries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Money taken online for an order, before there is a sale to hang it on.
-- -----------------------------------------------------------------------------

CREATE TYPE order_payment_status AS ENUM (
  'authorized',  -- held on the customer's card, not yet taken
  'captured',    -- taken, when the order was handed over
  'voided',      -- released without being taken
  'failed',
  'refunded'
);

CREATE TABLE order_payments (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id              uuid NOT NULL,
  order_id            uuid NOT NULL,
  -- 'test' until a card processor is chosen. Never a card number: a
  -- processor's reference, and at most the brand and last four digits.
  provider            text NOT NULL,
  provider_reference  text NOT NULL,
  amount_minor        money_minor NOT NULL,
  status              order_payment_status NOT NULL,
  card_brand          text,
  card_last4          char(4),
  failure_reason      text,
  authorized_at       timestamptz,
  captured_at         timestamptz,
  voided_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (order_id, org_id) REFERENCES orders (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT order_payment_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT order_payment_last4_fmt       CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT order_payment_captured_at     CHECK ((status = 'captured') = (captured_at IS NOT NULL) OR status = 'refunded'),
  CONSTRAINT order_payment_authorized_at   CHECK (status = 'failed' OR authorized_at IS NOT NULL)
);

-- At most one payment holding or having taken money for an order at a time.
CREATE UNIQUE INDEX order_payments_live_key ON order_payments (order_id)
  WHERE status IN ('authorized', 'captured');
CREATE UNIQUE INDEX order_payments_reference_key ON order_payments (provider, provider_reference);

CREATE TRIGGER order_payments_touch BEFORE UPDATE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER order_payments_no_delete BEFORE DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();

-- -----------------------------------------------------------------------------
-- A cart knows how it will be fulfilled, because what may be sold, what it
-- costs and how it is taxed all depend on it.
-- -----------------------------------------------------------------------------

ALTER TABLE carts
  ADD COLUMN fulfilment order_fulfilment NOT NULL DEFAULT 'pickup',
  -- For the delivery fee and "do you deliver here" while shopping. The full
  -- address is asked for at checkout and kept on the order, not here.
  ADD COLUMN delivery_postal_code text,
  ADD CONSTRAINT carts_postal_code_format CHECK (delivery_postal_code IS NULL OR delivery_postal_code ~ '^[0-9]{5}$');

-- -----------------------------------------------------------------------------
-- A courier's webhook names a delivery, not an organization.
--
-- The same narrow, definer-rights pattern as `shop_lookup_client`: given the
-- delivery id this system invented, say whose it is and nothing else, so the
-- webhook can then be handled under that organization's row-level security.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION delivery_lookup_order(p_external_delivery_id text)
RETURNS TABLE (org_id uuid, order_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT d.org_id, d.order_id
  FROM order_deliveries d
  WHERE d.external_delivery_id = p_external_delivery_id
$fn$;

REVOKE ALL ON FUNCTION delivery_lookup_order(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery_lookup_order(text) TO snappos_app;

-- -----------------------------------------------------------------------------

ALTER TABLE store_delivery_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON store_delivery_settings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE order_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON order_deliveries
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON order_payments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

INSERT INTO permissions (key, category, description) VALUES
  ('delivery.manage', 'storefront', 'Change where the shop delivers, the delivery fee and minimum order'),
  ('order.dispatch',  'orders',     'Request a courier for a delivery order')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator')
  AND p.key = 'delivery.manage'
ON CONFLICT DO NOTHING;

-- Whoever can work the order queue can send a finished order out with a courier.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator', 'manager', 'cashier')
  AND p.key = 'order.dispatch'
ON CONFLICT DO NOTHING;
