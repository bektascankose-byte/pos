-- =============================================================================
-- 0028_storefront_customers_and_carts.sql
--
-- What the website needs to take an order from a member of the public: a way
-- for the storefront server to identify itself, carts, and customer accounts.
--
-- NOTHING HERE IS A SECOND COPY. A customer who signs up online is a row in
-- `customers`, the same table the register writes, so a shopper who buys at
-- the counter and online is one person with one history. A cart holds variant
-- ids and quantities and nothing else -- never a price, because the price is
-- whatever the catalog says at the moment of checkout, and a stored one is a
-- stale one.
--
-- EVERY BEARER SECRET IS STORED HASHED. Shop keys, session tokens, cart tokens
-- and one-time email tokens are all random values the holder presents; only
-- their SHA-256 lands here, so a copy of this database does not hand anybody a
-- working session, cart or password reset. Order tracking links are not in
-- this migration at all: they are signed from the order id and verified
-- against a server secret, so there is nothing to store and nothing to leak.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shop keys.
--
-- The storefront is a server, and it calls this API from that server; a
-- shopper's browser never sees the key. The key does two jobs: it tells the
-- API which organization and store the website sells for, and it marks
-- requests as coming from that server, so the API can rate limit by the
-- shopper's own address rather than lumping every shopper in the country into
-- one bucket behind the storefront's IP.
-- -----------------------------------------------------------------------------

CREATE TABLE storefront_clients (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  store_id     uuid NOT NULL,
  name         text NOT NULL,
  key_hash     text NOT NULL,
  -- The first few characters, kept so a person can tell two keys apart on a
  -- screen without the rest of it ever being shown again.
  key_prefix   text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,

  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  CONSTRAINT storefront_clients_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX storefront_clients_key_hash_key ON storefront_clients (key_hash);

-- The key arrives before anything else is known, so finding its organization is
-- a cross tenant read -- the same situation as signing in, handled the same way
-- as `auth_lookup_user` in 0007: a definer function returning only what
-- routing needs, rather than a policy loosened for everyone.
CREATE OR REPLACE FUNCTION shop_lookup_client(p_key_hash text)
RETURNS TABLE (client_id uuid, org_id uuid, store_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.id, c.org_id, c.store_id
  FROM storefront_clients c
  JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
  JOIN stores s ON s.id = c.store_id AND s.status = 'active'
  WHERE c.key_hash = p_key_hash
    AND c.revoked_at IS NULL
  LIMIT 1;
$fn$;

REVOKE EXECUTE ON FUNCTION shop_lookup_client(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION shop_lookup_client(text) TO snappos_app';
  END IF;
END $$;

COMMENT ON FUNCTION shop_lookup_client(text) IS
  'Cross tenant by necessity: the organization is unknown until the key is found. '
  'Returns only what routing a storefront request needs.';

-- -----------------------------------------------------------------------------
-- Customer accounts.
--
-- One password per customer, hung off the existing customer row. The sign-in
-- email is `customers.email`, which is already unique per organization, so an
-- account cannot be created twice for one address.
-- -----------------------------------------------------------------------------

CREATE TABLE customer_credentials (
  customer_id         uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  password_hash       text NOT NULL,
  -- Null until the customer proves the address is theirs. Nobody signs in
  -- before then: an in-store customer's email is already on file, and without
  -- this anyone could register it and read that person's purchase history.
  email_verified_at   timestamptz,
  failed_attempts     smallint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE CASCADE
);

CREATE TRIGGER customer_credentials_touch BEFORE UPDATE ON customer_credentials
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Opaque session tokens rather than signed ones. A shopper's session is looked
-- up on every request, which at this volume costs nothing and buys instant
-- revocation: signing out, changing a password or resetting one ends every
-- session at once, with no window where a copied token still works.
CREATE TABLE customer_sessions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  customer_id  uuid NOT NULL,
  token_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,

  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE CASCADE,
  CONSTRAINT customer_sessions_expiry_after_start CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX customer_sessions_token_hash_key ON customer_sessions (token_hash);
CREATE INDEX customer_sessions_live_idx ON customer_sessions (customer_id) WHERE revoked_at IS NULL;

CREATE TYPE customer_token_purpose AS ENUM ('verify_email', 'reset_password');

-- One-time links sent by email. Short lived, single use, and hashed like
-- everything else here.
CREATE TABLE customer_tokens (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  customer_id uuid NOT NULL,
  purpose     customer_token_purpose NOT NULL,
  token_hash  text NOT NULL,
  -- What the link confirms besides the address itself. A marketing opt-in
  -- ticked at sign-up waits here and is recorded only when the link is
  -- followed: until then nobody has shown the inbox is theirs, and anyone could
  -- have typed it.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,

  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE CASCADE,
  CONSTRAINT customer_tokens_expiry_after_start CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX customer_tokens_token_hash_key ON customer_tokens (token_hash);
CREATE INDEX customer_tokens_open_idx ON customer_tokens (customer_id, purpose) WHERE used_at IS NULL;

-- -----------------------------------------------------------------------------
-- Carts.
-- -----------------------------------------------------------------------------

CREATE TABLE carts (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id             uuid NOT NULL,
  store_id           uuid NOT NULL,
  token_hash         text NOT NULL,
  customer_id        uuid,
  -- Set once, when checkout turns this cart into an order. It is what makes a
  -- double-clicked Place Order button produce one order: the second request
  -- finds the cart already converted and is handed the same order back.
  converted_order_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,

  FOREIGN KEY (store_id, org_id)           REFERENCES stores (id, org_id)    ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, org_id)        REFERENCES customers (id, org_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (converted_order_id, org_id) REFERENCES orders (id, org_id)    ON DELETE RESTRICT,
  UNIQUE (id, org_id),
  CONSTRAINT carts_expiry_after_start CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX carts_token_hash_key ON carts (token_hash);
CREATE UNIQUE INDEX carts_converted_order_key ON carts (converted_order_id) WHERE converted_order_id IS NOT NULL;
CREATE INDEX carts_customer_open_idx ON carts (customer_id, updated_at DESC)
  WHERE customer_id IS NOT NULL AND converted_order_id IS NULL;

CREATE TRIGGER carts_touch BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE cart_lines (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  cart_id     uuid NOT NULL,
  variant_id  uuid NOT NULL,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (cart_id, org_id)    REFERENCES carts (id, org_id)            ON DELETE CASCADE,
  FOREIGN KEY (variant_id, org_id) REFERENCES product_variants (id, org_id) ON DELETE CASCADE,
  -- One line per item: adding the same thing again changes the quantity.
  UNIQUE (cart_id, variant_id)
);

CREATE TRIGGER cart_lines_touch BEFORE UPDATE ON cart_lines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- What an order needs to know about where it came from.
-- -----------------------------------------------------------------------------

ALTER TABLE orders
  -- 'staff' for an order keyed in from the back office, 'storefront' for one a
  -- customer placed. Notifications go to the second kind only.
  ADD COLUMN placed_via text NOT NULL DEFAULT 'staff',
  -- When the customer stated they are old enough, at checkout. A statement, not
  -- a verification, and named so nobody mistakes one for the other: the check
  -- that counts happens at the counter, with the ID in hand.
  ADD COLUMN age_attested_at timestamptz,
  ADD CONSTRAINT orders_placed_via_known CHECK (placed_via IN ('staff', 'storefront'));

-- -----------------------------------------------------------------------------
-- Tenancy.
-- -----------------------------------------------------------------------------

ALTER TABLE storefront_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON storefront_clients
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE customer_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON customer_credentials
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON customer_sessions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE customer_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON customer_tokens
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON carts
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE cart_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON cart_lines
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
