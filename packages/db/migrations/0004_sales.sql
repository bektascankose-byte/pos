-- =============================================================================
-- 0004_sales.sql
-- Customers, cash sessions, sales, payments, refunds, age verification.
--
-- Everything here is an auditable financial record. Nothing is updated in
-- place. A void is a new state plus an audit row; a correction is a new sale;
-- a refund is its own document that references the original.
--
-- The sale id is generated ON THE REGISTER as a UUIDv7 before the receipt
-- prints. Server intake is INSERT ... ON CONFLICT DO NOTHING, which makes
-- duplicate upload structurally incapable of producing a duplicate sale.
-- =============================================================================

CREATE TYPE sale_status    AS ENUM ('parked', 'completed', 'voided');
CREATE TYPE sale_channel   AS ENUM ('in_store', 'pickup', 'delivery', 'online');
CREATE TYPE payment_method AS ENUM
  ('cash', 'card', 'gift_card', 'store_credit', 'external', 'check', 'other');
CREATE TYPE payment_status AS ENUM
  ('pending', 'authorized', 'captured', 'failed', 'voided', 'refunded');
CREATE TYPE cash_movement_kind AS ENUM
  ('opening_float', 'sale', 'refund', 'paid_in', 'paid_out', 'drop',
   'pickup', 'safe_deposit', 'adjustment', 'closing_count');
CREATE TYPE age_check_method AS ENUM ('scan', 'manual', 'provider', 'exempt');
CREATE TYPE age_check_result AS ENUM ('pass', 'fail', 'expired_id', 'unreadable', 'refused');

-- -----------------------------------------------------------------------------
-- Customers. Deliberately minimal. No date of birth unless volunteered for a
-- birthday reward, no ID data, no card numbers.
-- -----------------------------------------------------------------------------

CREATE TABLE customers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  first_name      text,
  last_name       text,
  phone           text,
  email           text,
  birth_month     smallint CHECK (birth_month BETWEEN 1 AND 12),
  birth_day       smallint CHECK (birth_day BETWEEN 1 AND 31),
  -- Month and day only. A birthday reward does not need a birth year, and not
  -- storing the year means this table is not an age database.
  home_store_id   uuid,
  notes           text,
  tags            text[] NOT NULL DEFAULT '{}',
  status          entity_status NOT NULL DEFAULT 'active',
  anonymized_at   timestamptz,          -- deletion request: scrub PII, keep sales
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (home_store_id, org_id) REFERENCES stores (id, org_id) ON DELETE SET NULL,
  CONSTRAINT customers_contactable
    CHECK (phone IS NOT NULL OR email IS NOT NULL OR anonymized_at IS NOT NULL),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX customers_org_phone_key ON customers (org_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX customers_org_email_key ON customers (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX customers_name_idx ON customers (org_id, lower(last_name), lower(first_name));
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Consent is timestamped, sourced and never inferred. A marketing send that
-- cannot point at a row here does not go out.
CREATE TABLE customer_consents (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  customer_id  uuid NOT NULL,
  channel      text NOT NULL,              -- sms | email
  granted      boolean NOT NULL,
  source       text NOT NULL,              -- 'register' | 'web_signup' | 'sms_stop' | 'import'
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ip, user agent, employee, wording shown
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE CASCADE
);
CREATE INDEX consents_customer_idx ON customer_consents (customer_id, channel, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- Cash sessions
-- -----------------------------------------------------------------------------

CREATE TABLE cash_sessions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id              uuid NOT NULL,
  store_id            uuid NOT NULL,
  register_id         uuid NOT NULL,
  opened_by           uuid NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opening_float_minor money_minor NOT NULL DEFAULT 0,
  closed_by           uuid,
  closed_at           timestamptz,
  -- Blind count: the counter does not see expected until after entry.
  blind               boolean NOT NULL DEFAULT true,
  counted_minor       money_minor,
  expected_minor      money_minor,
  variance_minor      money_minor GENERATED ALWAYS AS (counted_minor - expected_minor) STORED,
  denominations       jsonb,               -- {"100":2,"20":15,"5":8,"1":23,"0.25":40}
  note                text,
  FOREIGN KEY (store_id, org_id)    REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_id, org_id) REFERENCES registers (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT cash_session_closed CHECK (
    (closed_at IS NULL) = (closed_by IS NULL)
  ),
  UNIQUE (id, org_id)
);
-- One open session per register. This is the constraint that stops two cashiers
-- sharing a drawer without anyone noticing.
CREATE UNIQUE INDEX cash_sessions_open_key ON cash_sessions (register_id) WHERE closed_at IS NULL;
CREATE INDEX cash_sessions_store_idx ON cash_sessions (store_id, opened_at DESC);

CREATE TABLE cash_movements (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  session_id   uuid NOT NULL,
  kind         cash_movement_kind NOT NULL,
  amount_minor money_minor NOT NULL,       -- signed: paid_out and drop are negative
  reason       text,
  reference_type text,
  reference_id uuid,
  actor_user_id uuid NOT NULL,
  approved_by  uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  device_id    uuid,
  note         text,
  FOREIGN KEY (session_id, org_id) REFERENCES cash_sessions (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_reason CHECK (
    kind NOT IN ('paid_in','paid_out','adjustment','drop') OR reason IS NOT NULL
  )
);
CREATE INDEX cash_movements_session_idx ON cash_movements (session_id, occurred_at);
CREATE INDEX cash_movements_actor_idx   ON cash_movements (org_id, actor_user_id, occurred_at DESC);

-- Every drawer open, including no sale opens, lands here. This is where the
-- loss prevention reports get their signal.
CREATE TABLE drawer_opens (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  store_id     uuid NOT NULL,
  register_id  uuid NOT NULL,
  session_id   uuid,
  user_id      uuid NOT NULL,
  sale_id      uuid,                       -- null = no sale open
  reason       text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (register_id, org_id) REFERENCES registers (id, org_id) ON DELETE CASCADE
);
CREATE INDEX drawer_opens_nosale_idx ON drawer_opens (org_id, user_id, occurred_at DESC)
  WHERE sale_id IS NULL;

-- -----------------------------------------------------------------------------
-- Sales
-- -----------------------------------------------------------------------------

CREATE TABLE sales (
  -- Generated on the register, offline, before the receipt prints.
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  store_id          uuid NOT NULL,
  register_id       uuid NOT NULL,
  device_id         uuid,
  session_id        uuid,
  cashier_user_id   uuid NOT NULL,
  customer_id       uuid,

  receipt_no        text NOT NULL,          -- 'HH01-R1-004173' or a leased sequence
  register_sequence bigint NOT NULL,        -- monotonic per register
  channel           sale_channel NOT NULL DEFAULT 'in_store',
  status            sale_status NOT NULL DEFAULT 'completed',

  subtotal_minor    money_minor NOT NULL DEFAULT 0,
  discount_minor    money_minor NOT NULL DEFAULT 0,
  tax_minor         money_minor NOT NULL DEFAULT 0,
  tip_minor         money_minor NOT NULL DEFAULT 0,
  total_minor       money_minor NOT NULL DEFAULT 0,
  cost_total        numeric(16,6) NOT NULL DEFAULT 0,   -- COGS snapshot at sale time

  tax_exempt        boolean NOT NULL DEFAULT false,
  tax_exempt_reason text,
  note              text,

  -- Timing. device_time can be wrong; reports use server time.
  device_time       timestamptz NOT NULL,
  completed_at      timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz,

  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text,
  parked_label      text,                   -- 'Blue shirt guy' for held tickets

  -- Recorded when the server's recomputation disagrees with the register's.
  -- The sale still stands; the difference becomes a variance report line.
  price_variance_minor money_minor NOT NULL DEFAULT 0,

  FOREIGN KEY (store_id, org_id)    REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_id, org_id) REFERENCES registers (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE SET NULL,
  FOREIGN KEY (session_id, org_id)  REFERENCES cash_sessions (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT sales_void_fields CHECK (
    (status = 'voided') = (voided_at IS NOT NULL)
  ),
  CONSTRAINT sales_completed_fields CHECK (
    status <> 'completed' OR completed_at IS NOT NULL
  ),
  CONSTRAINT sales_tax_exempt_reason CHECK (
    NOT tax_exempt OR tax_exempt_reason IS NOT NULL
  ),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX sales_receipt_key  ON sales (org_id, receipt_no);
CREATE UNIQUE INDEX sales_register_seq_key ON sales (register_id, register_sequence);
CREATE INDEX sales_store_time_idx  ON sales (store_id, completed_at DESC) WHERE status = 'completed';
CREATE INDEX sales_cashier_idx     ON sales (org_id, cashier_user_id, completed_at DESC);
CREATE INDEX sales_customer_idx    ON sales (customer_id, completed_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_session_idx     ON sales (session_id);
CREATE INDEX sales_parked_idx      ON sales (store_id) WHERE status = 'parked';
CREATE INDEX sales_unsynced_idx    ON sales (org_id, received_at) WHERE synced_at IS NULL;

CREATE TABLE sale_lines (
  id                 uuid PRIMARY KEY,      -- also register generated
  org_id             uuid NOT NULL,
  sale_id            uuid NOT NULL,
  line_no            smallint NOT NULL,
  variant_id         uuid NOT NULL,

  -- Denormalized on purpose. A product renamed in 2027 must not change what a
  -- 2026 receipt reprint says.
  description        text NOT NULL,
  sku_snapshot       text NOT NULL,
  barcode_scanned    text,

  quantity           numeric(14,3) NOT NULL CHECK (quantity <> 0),
  unit_price_minor   money_minor NOT NULL CHECK (unit_price_minor >= 0),
  original_price_minor money_minor NOT NULL,
  price_overridden   boolean NOT NULL DEFAULT false,
  override_by        uuid,
  override_reason    text,

  discount_minor     money_minor NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor          money_minor NOT NULL DEFAULT 0,
  total_minor        money_minor NOT NULL,
  unit_cost          numeric(14,6) NOT NULL DEFAULT 0,   -- COGS at sale time

  tax_snapshot       jsonb NOT NULL DEFAULT '[]'::jsonb, -- rates applied, for audit
  promotion_ids      uuid[] NOT NULL DEFAULT '{}',
  compliance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, -- min age applied, rules matched

  -- The one mutable column on this table, guarded by a CHECK and by the
  -- immutability trigger's allowlist. Prevents refunding more than was sold.
  quantity_refunded  numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_refunded >= 0),

  FOREIGN KEY (sale_id, org_id)    REFERENCES sales (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT sale_line_refund_bound CHECK (quantity_refunded <= abs(quantity)),
  CONSTRAINT sale_line_override_reason CHECK (NOT price_overridden OR override_by IS NOT NULL),
  UNIQUE (sale_id, line_no),
  UNIQUE (id, org_id)
);
CREATE INDEX sale_lines_variant_idx ON sale_lines (variant_id);
CREATE INDEX sale_lines_sale_idx    ON sale_lines (sale_id, line_no);
CREATE INDEX sale_lines_override_idx ON sale_lines (org_id, override_by) WHERE price_overridden;

CREATE TABLE sale_line_discounts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  sale_line_id  uuid NOT NULL,
  source        text NOT NULL,           -- 'promotion' | 'manual' | 'loyalty' | 'employee'
  promotion_id  uuid,
  label         text NOT NULL,           -- printed on the receipt
  amount_minor  money_minor NOT NULL CHECK (amount_minor > 0),
  applied_by    uuid,
  approved_by   uuid,
  FOREIGN KEY (sale_line_id, org_id) REFERENCES sale_lines (id, org_id) ON DELETE CASCADE
);
CREATE INDEX sale_line_discounts_line_idx ON sale_line_discounts (sale_line_id);
CREATE INDEX sale_line_discounts_manual_idx ON sale_line_discounts (org_id, applied_by)
  WHERE source = 'manual';

-- -----------------------------------------------------------------------------
-- Refunds. Their own document, referencing the original. Never an edit of the
-- original sale.
-- -----------------------------------------------------------------------------

CREATE TABLE refunds (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  store_id          uuid NOT NULL,
  register_id       uuid NOT NULL,
  session_id        uuid,
  original_sale_id  uuid,                  -- null = no receipt refund, needs permission
  customer_id       uuid,
  cashier_user_id   uuid NOT NULL,
  approved_by       uuid,
  receipt_no        text NOT NULL,
  reason_code       text NOT NULL,
  reason_note       text,
  subtotal_minor    money_minor NOT NULL DEFAULT 0,
  tax_minor         money_minor NOT NULL DEFAULT 0,
  total_minor       money_minor NOT NULL DEFAULT 0,
  restock           boolean NOT NULL DEFAULT true,
  device_time       timestamptz NOT NULL,
  completed_at      timestamptz NOT NULL DEFAULT now(),
  received_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id)         REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_id, org_id)      REFERENCES registers (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_sale_id, org_id) REFERENCES sales (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, org_id)      REFERENCES customers (id, org_id) ON DELETE SET NULL,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX refunds_receipt_key ON refunds (org_id, receipt_no);
CREATE INDEX refunds_original_idx ON refunds (original_sale_id);
CREATE INDEX refunds_cashier_idx  ON refunds (org_id, cashier_user_id, completed_at DESC);

CREATE TABLE refund_lines (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  refund_id     uuid NOT NULL,
  sale_line_id  uuid,                      -- null for a no receipt refund
  variant_id    uuid NOT NULL,
  description   text NOT NULL,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_minor money_minor NOT NULL,
  tax_minor     money_minor NOT NULL DEFAULT 0,
  total_minor   money_minor NOT NULL,
  unit_cost     numeric(14,6) NOT NULL DEFAULT 0,
  restocked     boolean NOT NULL DEFAULT true,
  condition     text,                      -- 'resalable' | 'damaged' | 'opened'
  FOREIGN KEY (refund_id, org_id)    REFERENCES refunds (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (sale_line_id, org_id) REFERENCES sale_lines (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id, org_id)   REFERENCES product_variants (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX refund_lines_refund_idx ON refund_lines (refund_id);
CREATE INDEX refund_lines_saleline_idx ON refund_lines (sale_line_id);

-- -----------------------------------------------------------------------------
-- Payments. NO CARD DATA EVER LANDS HERE.
-- The register sends an amount to a PCI validated P2PE terminal; the terminal
-- handles the card independently and returns an approval plus a token. What we
-- keep is the token, the last four, the brand, the auth code and the amount.
-- That is the difference between a short SAQ B-IP self assessment and a full
-- SAQ D audit.
-- -----------------------------------------------------------------------------

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  sale_id             uuid,
  refund_id           uuid,
  method              payment_method NOT NULL,
  status              payment_status NOT NULL DEFAULT 'captured',

  amount_minor        money_minor NOT NULL,        -- negative for a refund tender
  tendered_minor      money_minor,                 -- cash given
  change_minor        money_minor NOT NULL DEFAULT 0,
  tip_minor           money_minor NOT NULL DEFAULT 0,

  provider            text,                        -- 'nmi' | 'authorize_net' | 'usaepay'
  provider_payment_id text,
  provider_token      text,                        -- gateway token, not a PAN
  card_last4          char(4),
  card_brand          text,
  entry_mode          text,                        -- chip | contactless | swipe | manual
  auth_code           text,
  terminal_serial     text,
  gift_card_id        uuid,
  store_credit_txn_id uuid,

  captured_at         timestamptz,
  failed_reason       text,
  device_time         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (sale_id, org_id)   REFERENCES sales (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (refund_id, org_id) REFERENCES refunds (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT payment_target CHECK (num_nonnulls(sale_id, refund_id) = 1),
  -- Belt and braces: four digits is all a card column may ever hold here.
  CONSTRAINT payment_last4_fmt CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT payment_cash_fields CHECK (method <> 'cash' OR provider_token IS NULL),
  UNIQUE (id, org_id)
);
CREATE INDEX payments_sale_idx     ON payments (sale_id);
CREATE INDEX payments_refund_idx   ON payments (refund_id);
CREATE INDEX payments_provider_idx ON payments (provider, provider_payment_id);
CREATE INDEX payments_method_idx   ON payments (org_id, method, created_at DESC);

-- Append only history of what the gateway did. Retries, reversals, webhook
-- callbacks and failed captures all land here so a disputed transaction can be
-- reconstructed exactly.
CREATE TABLE payment_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  payment_id    uuid NOT NULL,
  event_type    text NOT NULL,       -- authorize | capture | void | reverse | webhook
  status        payment_status,
  amount_minor  money_minor,
  provider_ref  text,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- scrubbed of any card data
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, org_id) REFERENCES payments (id, org_id) ON DELETE CASCADE
);
CREATE INDEX payment_events_payment_idx ON payment_events (payment_id, occurred_at);

-- -----------------------------------------------------------------------------
-- Age verification. MINIMAL METADATA ONLY.
-- The AAMVA PDF417 barcode is parsed on the device; date of birth and expiry
-- are used to compute pass or fail and everything else is discarded
-- immediately. The raw payload is never transmitted and never written to disk.
-- No name. No address. No license number. No image.
-- -----------------------------------------------------------------------------

CREATE TABLE age_verifications (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id             uuid NOT NULL,
  store_id           uuid NOT NULL,
  register_id        uuid,
  sale_id            uuid,
  sale_line_id       uuid,
  order_id           uuid,                    -- online orders, Phase 5
  method             age_check_method NOT NULL,
  result             age_check_result NOT NULL,
  minimum_age_applied smallint NOT NULL,
  -- For method = 'provider' only. An opaque reference, never the documents the
  -- provider collected.
  provider           text,
  provider_token     text,
  employee_user_id   uuid,
  device_id          uuid,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_id, org_id)  REFERENCES sales (id, org_id) ON DELETE SET NULL,
  CONSTRAINT age_check_provider_fields
    CHECK (method <> 'provider' OR provider IS NOT NULL)
);
CREATE INDEX age_verifications_sale_idx  ON age_verifications (sale_id);
CREATE INDEX age_verifications_store_idx ON age_verifications (store_id, verified_at DESC);
CREATE INDEX age_verifications_fail_idx  ON age_verifications (org_id, verified_at DESC)
  WHERE result <> 'pass';

-- Receipt delivery attempts, so "the customer says they never got it" is
-- answerable.
CREATE TABLE receipt_deliveries (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  sale_id      uuid,
  refund_id    uuid,
  channel      text NOT NULL,            -- print | email | sms | none
  destination  text,
  status       text NOT NULL DEFAULT 'queued',
  error        text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY (sale_id, org_id)   REFERENCES sales (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (refund_id, org_id) REFERENCES refunds (id, org_id) ON DELETE CASCADE
);
CREATE INDEX receipt_deliveries_sale_idx ON receipt_deliveries (sale_id);

-- -----------------------------------------------------------------------------
-- Immutability guard.
-- Completed sales and their lines are facts. The only permitted mutations are
-- the void transition, the sync bookkeeping columns and the refund counter.
-- Anything else must be a new row.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guard_sale_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status = 'completed' THEN
    IF (NEW.id, NEW.org_id, NEW.store_id, NEW.register_id, NEW.receipt_no,
        NEW.register_sequence, NEW.subtotal_minor, NEW.discount_minor,
        NEW.tax_minor, NEW.total_minor, NEW.cashier_user_id, NEW.completed_at)
       IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.store_id, OLD.register_id, OLD.receipt_no,
        OLD.register_sequence, OLD.subtotal_minor, OLD.discount_minor,
        OLD.tax_minor, OLD.total_minor, OLD.cashier_user_id, OLD.completed_at)
    THEN
      RAISE EXCEPTION
        'sale % is completed and its financial fields are immutable; record a void or a refund instead',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER sales_immutable BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION guard_sale_immutable();

CREATE OR REPLACE FUNCTION guard_sale_line_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- quantity_refunded is the one mutable column.
  IF (NEW.id, NEW.sale_id, NEW.variant_id, NEW.quantity, NEW.unit_price_minor,
      NEW.discount_minor, NEW.tax_minor, NEW.total_minor, NEW.unit_cost)
     IS DISTINCT FROM
     (OLD.id, OLD.sale_id, OLD.variant_id, OLD.quantity, OLD.unit_price_minor,
      OLD.discount_minor, OLD.tax_minor, OLD.total_minor, OLD.unit_cost)
  THEN
    RAISE EXCEPTION
      'sale_line % is immutable except for quantity_refunded', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER sale_lines_immutable BEFORE UPDATE ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION guard_sale_line_immutable();

-- Deleting a financial record is never correct.
CREATE OR REPLACE FUNCTION guard_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'rows in % are financial records and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $fn$;

CREATE TRIGGER sales_no_delete    BEFORE DELETE ON sales    FOR EACH ROW EXECUTE FUNCTION guard_no_delete();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION guard_no_delete();
CREATE TRIGGER refunds_no_delete  BEFORE DELETE ON refunds  FOR EACH ROW EXECUTE FUNCTION guard_no_delete();
