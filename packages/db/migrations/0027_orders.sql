-- =============================================================================
-- 0027_orders.sql
--
-- An order is not a sale.
--
-- `sales` is immutable and complete -- the invariants suite enforces that its
-- total cannot be edited and that it cannot be deleted, because a receipt
-- reprinted in 2027 must say what it said in 2026. An online order is the
-- opposite of all of that: it is a promise, it can be rejected, it can lose a
-- line to an out-of-stock, and it can fail at the door. Forcing one into the
-- other would either break the guarantees the register depends on or wreck the
-- reporting.
--
-- So an order has its own lifecycle and **produces** a sale at handoff, in the
-- same transaction as the inventory movement that explains where the goods
-- went. Before that instant nothing has moved: an order is a claim on stock,
-- not a deduction from it. Reports keep working unchanged, because by the time
-- they see it a fulfilled online order is an ordinary `sales` row with
-- `channel = 'pickup'`.
--
-- WHAT IS NOT HERE. Carts belong with the storefront that fills them, and
-- payment states are declared in the status enum but unreachable until there
-- is a payment provider to reach them. Declaring the full vocabulary now and
-- implementing part of it is deliberate: the state machine is checked against
-- this enum, so a transition nobody has built yet fails loudly rather than
-- being quietly permitted by an enum that forgot to mention it.
-- =============================================================================

CREATE TYPE order_fulfilment AS ENUM ('pickup', 'delivery');

CREATE TYPE order_status AS ENUM (
  -- Reachable today.
  'placed',          -- the customer submitted it; stock is claimed, not moved
  'accepted',        -- staff took it
  'preparing',
  'ready',           -- waiting at the counter, or for a courier
  'completed',       -- handed over; a sale exists
  'rejected',        -- staff refused it
  'cancelled',
  -- Declared for later phases. No transition reaches these yet.
  'pending_payment',
  'payment_failed',
  'courier_requested',
  'in_transit',
  'delivery_failed',
  'returned_to_store'
);

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  store_id       uuid NOT NULL,

  -- What staff and the customer both call it. Short enough to read down a
  -- phone, unique per org.
  order_number   text NOT NULL,

  -- A known customer, or a guest. Exactly one of these, enforced below: an
  -- order with neither cannot be handed to anybody, and one with both is
  -- ambiguous about whose loyalty and verification apply.
  customer_id    uuid,
  guest_name     text,
  guest_email    text,
  guest_phone    text,

  fulfilment     order_fulfilment NOT NULL,
  status         order_status NOT NULL DEFAULT 'placed',

  subtotal_minor     money_minor NOT NULL DEFAULT 0,
  discount_minor     money_minor NOT NULL DEFAULT 0,
  tax_minor          money_minor NOT NULL DEFAULT 0,
  delivery_fee_minor money_minor NOT NULL DEFAULT 0,
  total_minor        money_minor NOT NULL DEFAULT 0,

  -- When the customer asked to collect. Advisory: the shop decides when it is
  -- actually ready, and `ready_at` is that.
  pickup_from    timestamptz,
  pickup_to      timestamptz,

  note           text,
  -- Why it was refused or cancelled, shown to the customer.
  resolution_note text,

  -- The sale this order produced, set once at handoff. Null until then, and
  -- that nullness is the honest answer to "has this moved stock yet".
  sale_id        uuid,

  -- The request that placed it, carried into every event and outbox message so
  -- one order is traceable across systems.
  correlation_id text,

  placed_at      timestamptz NOT NULL DEFAULT now(),
  accepted_at    timestamptz,
  ready_at       timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (store_id, org_id)    REFERENCES stores    (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_id, org_id)     REFERENCES sales     (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id),

  CONSTRAINT orders_has_somebody CHECK (
    (customer_id IS NOT NULL) OR (guest_email IS NOT NULL OR guest_phone IS NOT NULL)
  ),
  -- A completed order without a sale would be stock that left with nothing to
  -- explain it; a sale on an order that is not completed would be the reverse.
  CONSTRAINT orders_completed_has_sale CHECK ((status = 'completed') = (sale_id IS NOT NULL)),
  CONSTRAINT orders_completed_at_set   CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT orders_pickup_window_ordered CHECK (pickup_to IS NULL OR pickup_from IS NULL OR pickup_to > pickup_from)
);

CREATE UNIQUE INDEX orders_number_key ON orders (org_id, upper(order_number));
-- The POS queue's own query: what needs attention, oldest first.
CREATE INDEX orders_queue_idx ON orders (store_id, status, placed_at)
  WHERE status IN ('placed', 'accepted', 'preparing', 'ready');
CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC) WHERE customer_id IS NOT NULL;

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------

CREATE TABLE order_lines (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  order_id       uuid NOT NULL,
  variant_id     uuid NOT NULL,

  quantity           numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_minor   money_minor NOT NULL,
  line_total_minor   money_minor NOT NULL,

  -- Denormalized for the same reason `sale_lines` does it: a product renamed
  -- next month must not change what this order said when it was placed.
  description    text NOT NULL,
  upc_snapshot   text NOT NULL,

  -- Set when staff resolve a line that cannot be filled, rather than deleting
  -- it -- a customer who ordered four and got three should be able to see that
  -- happened.
  removed_at     timestamptz,
  removed_reason text,

  created_at     timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (order_id, org_id)   REFERENCES orders (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT order_line_removed_explained
    CHECK (removed_at IS NULL OR btrim(COALESCE(removed_reason, '')) <> '')
);

CREATE INDEX order_lines_order_idx ON order_lines (order_id, created_at);

-- -----------------------------------------------------------------------------
-- The timeline. Append only, one row per transition, never updated.
--
-- This is what the POS shows staff and what answers "who accepted this and
-- when" three weeks later. Storing the previous status on each row rather than
-- deriving it means the history survives the enum gaining values.
-- -----------------------------------------------------------------------------

CREATE TABLE order_events (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL,
  order_id       uuid NOT NULL,

  from_status    order_status,           -- null on the first event
  to_status      order_status NOT NULL,
  actor_user_id  uuid,
  -- 'staff' | 'customer' | 'system'. Text rather than an enum because the list
  -- grows with each integration and none of it drives behaviour.
  actor_type     text NOT NULL DEFAULT 'staff',
  reason         text,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (order_id, org_id) REFERENCES orders (id, org_id) ON DELETE CASCADE
);

CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON orders
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON order_lines
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON order_events
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

INSERT INTO permissions (key, category, description) VALUES
  ('order.view',   'orders', 'View online orders'),
  ('order.manage', 'orders', 'Accept, reject, prepare and hand over online orders'),
  ('order.cancel', 'orders', 'Cancel an online order after it was accepted')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator', 'manager')
  AND p.key IN ('order.view', 'order.manage', 'order.cancel')
ON CONFLICT DO NOTHING;

-- A cashier works the queue but cannot cancel a taken order; that is the step
-- that disappoints a customer who has already been told it is coming.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'cashier'
  AND p.key IN ('order.view', 'order.manage')
ON CONFLICT DO NOTHING;
