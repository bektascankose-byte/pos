-- =============================================================================
-- 0001_foundation.sql
-- Tenancy, identity, RBAC, audit, sync primitives.
--
-- Conventions used throughout every migration in this project:
--   * Primary keys are UUIDv7 (time ordered, client generatable offline).
--   * Every tenant table carries org_id and exposes UNIQUE (id, org_id) so that
--     child tables can use composite FKs. A row physically cannot reference a
--     parent belonging to another organization.
--   * Posted money is bigint minor units (cents), suffixed _minor.
--     Catalog cost rates are numeric(14,6). See docs/MONEY.md.
--   * Quantities are numeric(14,3) so weight sold items work without a second
--     code path.
--   * Financial and inventory history is append only. Nothing is updated in
--     place; a correction is a new row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- UUIDv7. Postgres 18 ships uuidv7() natively; this keeps us portable to 14-17
-- and keeps the Kotlin implementation on the register byte for byte identical.
--
-- Layout: 48 bits unix ms | 4 bits version | 12 bits rand_a | 2 bits variant |
--         62 bits random.
--
-- rand_a carries sub millisecond precision plus a monotonic counter rather than
-- random bits (RFC 9562 "replace leftmost random bits with increased clock
-- precision", combined with the monotonic counter method).
--
-- Why both, rather than trusting the clock:
--   * Ids minted in the same millisecond would otherwise sort randomly against
--     each other, losing index locality on burst inserts and making id order
--     useless for tie breaking sales rung back to back at a busy counter.
--   * Sub millisecond precision alone is not enough, because the register mints
--     these ids too and Android's millisecond clock has no finer resolution to
--     draw on. The counter makes ordering a property of the algorithm rather
--     than of the host's timer, which is what lets the Kotlin implementation
--     behave identically.
--   * clock_timestamp() can also move backwards across an NTP correction.
--
-- The counter is session scoped. Two sessions minting in the same 244ns window
-- fall back to the 62 random bits, where collision probability is negligible.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $fn$
DECLARE
  t        numeric;
  ms       bigint;
  sub      int;
  prev     text;
  prev_ms  bigint;
  prev_sub int;
  b        bytea;
BEGIN
  t   := extract(epoch FROM clock_timestamp()) * 1000;
  ms  := floor(t)::bigint;
  sub := floor((t - ms) * 4096)::int;                 -- 0 .. 4095

  prev := current_setting('app.uuid7_prev', true);
  IF prev IS NOT NULL AND prev <> '' THEN
    prev_ms  := split_part(prev, ':', 1)::bigint;
    prev_sub := split_part(prev, ':', 2)::int;
    -- Clock did not advance far enough, or went backwards. Step the counter.
    IF ms < prev_ms OR (ms = prev_ms AND sub <= prev_sub) THEN
      ms  := prev_ms;
      sub := prev_sub + 1;
      IF sub > 4095 THEN
        ms  := ms + 1;
        sub := 0;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.uuid7_prev', ms || ':' || sub, false);

  b := substring(int8send(ms) FROM 3 FOR 6)
       || substring(uuid_send(gen_random_uuid()) FROM 7 FOR 10);

  b := set_byte(b, 6, 112 | (sub >> 8));              -- version 7 | rand_a high
  b := set_byte(b, 7, sub & 255);                     -- rand_a low
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);   -- variant 10

  RETURN encode(b, 'hex')::uuid;
END $fn$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

-- Creates monthly range partitions for a partitioned table. Called by a cron
-- job twelve months ahead. Idempotent.
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(
  p_table text,
  p_from  date,
  p_months int DEFAULT 12
) RETURNS int
LANGUAGE plpgsql AS $fn$
DECLARE
  i int;
  lo date;
  hi date;
  part text;
  made int := 0;
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    lo   := date_trunc('month', p_from)::date + (i || ' months')::interval;
    hi   := lo + interval '1 month';
    part := format('%s_p%s', p_table, to_char(lo, 'YYYYMM'));
    IF to_regclass(format('public.%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
        part, p_table, lo, hi
      );
      made := made + 1;
    END IF;
  END LOOP;
  RETURN made;
END $fn$;

-- -----------------------------------------------------------------------------
-- Domains and enums
-- -----------------------------------------------------------------------------

CREATE DOMAIN money_minor AS bigint;   -- always minor units, never a float

CREATE TYPE entity_status  AS ENUM ('active', 'inactive', 'suspended', 'archived');
CREATE TYPE user_status    AS ENUM ('invited', 'active', 'suspended', 'terminated');
CREATE TYPE device_status  AS ENUM ('pending', 'enrolled', 'suspended', 'wiped');
CREATE TYPE change_op      AS ENUM ('insert', 'update', 'delete');

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  slug          text NOT NULL,
  legal_name    text NOT NULL,
  display_name  text NOT NULL,
  country       char(2) NOT NULL DEFAULT 'US',
  default_tz    text NOT NULL DEFAULT 'America/Chicago',
  currency      char(3) NOT NULL DEFAULT 'USD',
  status        entity_status NOT NULL DEFAULT 'active',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_fmt CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE UNIQUE INDEX organizations_slug_key ON organizations (slug);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE stores (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code            text NOT NULL,               -- short code, used in receipt numbers
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'America/Chicago',
  phone           text,
  email           text,
  address_line1   text,
  address_line2   text,
  city            text,
  region          text,                        -- state / province
  postal_code     text,
  country         char(2) NOT NULL DEFAULT 'US',
  county          text,                        -- compliance rules can scope to county
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  status          entity_status NOT NULL DEFAULT 'active',
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_code_fmt CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX stores_org_code_key ON stores (org_id, code);
CREATE INDEX stores_org_idx ON stores (org_id) WHERE status = 'active';
CREATE TRIGGER stores_touch BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE store_hours (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  store_id    uuid NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at    time NOT NULL,
  closes_at   time NOT NULL,
  channel     text NOT NULL DEFAULT 'store',   -- store | pickup | delivery
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE CASCADE,
  UNIQUE (store_id, channel, day_of_week)
);

CREATE TABLE registers (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  store_id    uuid NOT NULL,
  code        text NOT NULL,                   -- e.g. 'R1', used in receipt numbers
  name        text NOT NULL,
  status      entity_status NOT NULL DEFAULT 'active',
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- layout, favorites, hardware bindings
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registers_code_fmt CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX registers_store_code_key ON registers (store_id, code);
CREATE TRIGGER registers_touch BEFORE UPDATE ON registers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A physical Android terminal. Separate from register because a terminal can be
-- swapped without changing the register's identity in reports.
CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL,
  store_id          uuid NOT NULL,
  register_id       uuid,
  label             text NOT NULL,
  platform          text NOT NULL DEFAULT 'android',
  manufacturer      text,
  model             text,
  os_version        text,
  app_version       text,
  -- Long lived device credential. Hashed, never stored in the clear.
  credential_hash   text NOT NULL,
  credential_rotated_at timestamptz NOT NULL DEFAULT now(),
  clock_offset_ms   bigint NOT NULL DEFAULT 0,  -- measured at handshake
  last_seen_at      timestamptz,
  last_sync_cursor  bigint NOT NULL DEFAULT 0,  -- change_log.id watermark
  status            device_status NOT NULL DEFAULT 'pending',
  wipe_requested_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, org_id)    REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (register_id, org_id) REFERENCES registers (id, org_id) ON DELETE SET NULL,
  UNIQUE (id, org_id)
);
CREATE INDEX devices_store_idx ON devices (store_id) WHERE status = 'enrolled';
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Identity and RBAC
-- -----------------------------------------------------------------------------

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email          text,
  phone          text,
  full_name      text NOT NULL,
  display_name   text,                      -- shown on receipts: "Maria"
  password_hash  text,                      -- Argon2id. Null for PIN only staff.
  mfa_secret_enc text,                      -- encrypted at rest, app layer
  mfa_enabled    boolean NOT NULL DEFAULT false,
  employee_code  text,                      -- badge / payroll id
  hired_at       date,
  status         user_status NOT NULL DEFAULT 'invited',
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_contactable CHECK (email IS NOT NULL OR phone IS NOT NULL),
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX users_org_email_key ON users (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_org_code_key  ON users (org_id, employee_code) WHERE employee_code IS NOT NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- PINs are separate so they can be replicated to registers for offline unlock
-- without shipping password hashes to a device that sits on a counter.
CREATE TABLE employee_pins (
  user_id     uuid PRIMARY KEY,
  org_id      uuid NOT NULL,
  pin_hash    text NOT NULL,                -- Argon2id
  failed_count smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  category    text NOT NULL,
  description text NOT NULL
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = system role
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL GENERATED ALWAYS AS (org_id IS NULL) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_org_key     ON roles (org_id, key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX roles_system_key  ON roles (key)         WHERE org_id IS NULL;

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- A user can hold a role globally (store_id null) or at one store.
CREATE TABLE user_roles (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id     uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  store_id   uuid,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id)  REFERENCES users (id, org_id)  ON DELETE CASCADE,
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX user_roles_unique
  ON user_roles (user_id, role_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Refresh tokens. Opaque, hashed, rotated on use. Reuse of a rotated token
-- revokes the entire family, which turns a stolen token into a detected
-- incident instead of a persistent backdoor.
CREATE TABLE auth_sessions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id          uuid NOT NULL,
  user_id         uuid NOT NULL,
  family_id       uuid NOT NULL,
  token_hash      text NOT NULL,
  device_id       uuid,
  user_agent      text,
  ip              inet,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  revoked_reason  text,
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX auth_sessions_token_key ON auth_sessions (token_hash);
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
CREATE INDEX auth_sessions_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE time_clock_entries (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  user_id       uuid NOT NULL,
  clock_in_at   timestamptz NOT NULL,
  clock_out_at  timestamptz,
  break_minutes integer NOT NULL DEFAULT 0,
  source        text NOT NULL DEFAULT 'register',
  note          text,
  edited_by     uuid,
  edited_at     timestamptz,
  FOREIGN KEY (user_id, org_id)  REFERENCES users (id, org_id),
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id),
  CONSTRAINT time_clock_order CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at)
);
CREATE INDEX time_clock_user_idx ON time_clock_entries (user_id, clock_in_at DESC);
-- One open shift per employee at a time.
CREATE UNIQUE INDEX time_clock_open_key ON time_clock_entries (user_id) WHERE clock_out_at IS NULL;

-- -----------------------------------------------------------------------------
-- Audit log: partitioned monthly, hash chained per organization.
-- The chain is sealed asynchronously by one serialized worker rather than a
-- trigger, because a trigger cannot order concurrent inserts without taking a
-- lock that would slow down checkout.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
  id            uuid NOT NULL DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_type    text NOT NULL DEFAULT 'user',   -- user | system | device | api_key
  device_id     uuid,
  store_id      uuid,
  register_id   uuid,
  action        text NOT NULL,                  -- 'sale.void', 'product.price_change'
  entity_type   text,
  entity_id     uuid,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  ip            inet,
  request_id    text,
  seq           bigint,                         -- assigned by the sealer
  prev_hash     bytea,
  hash          bytea,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_log_org_time_idx  ON audit_log (org_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx     ON audit_log (org_id, actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx    ON audit_log (org_id, entity_type, entity_id);
CREATE INDEX audit_log_action_idx    ON audit_log (org_id, action, occurred_at DESC);
CREATE INDEX audit_log_unsealed_idx  ON audit_log (org_id, occurred_at) WHERE hash IS NULL;

SELECT ensure_monthly_partitions('audit_log', (date_trunc('month', now()) - interval '1 month')::date, 14);

-- -----------------------------------------------------------------------------
-- Sync primitives
-- -----------------------------------------------------------------------------

-- Downstream sync cursor. Written in the SAME transaction as the entity change.
-- Readers must not consume past the transaction watermark, because a bigserial
-- value is allocated before commit and rows can become visible out of order.
-- See sync_changes_watermark() below.
CREATE TABLE change_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  store_id     uuid,                    -- null = applies to every store
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  op           change_op NOT NULL,
  payload_hash text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_cursor_idx ON change_log (org_id, id);
CREATE INDEX change_log_store_idx  ON change_log (org_id, store_id, id);

-- Highest change_log.id that is safe to hand to a client. Any row at or above
-- this id may belong to a transaction that has not committed yet, so consuming
-- past it would permanently skip rows.
CREATE OR REPLACE FUNCTION sync_changes_watermark() RETURNS bigint
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(
    (SELECT min(c.id) - 1
       FROM change_log c
      WHERE c.xmin::text::bigint >= pg_snapshot_xmin(pg_current_snapshot())::text::bigint),
    (SELECT COALESCE(max(id), 0) FROM change_log)
  );
$fn$;

-- Transactional outbox. Domain events are written here inside the business
-- transaction, then relayed to Redis. This is the only way "sale committed" and
-- "sale event published" cannot diverge.
CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  store_id      uuid,
  event_type    text NOT NULL,           -- 'SaleCompleted', 'LowStockDetected'
  aggregate_type text NOT NULL,
  aggregate_id  uuid NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_pending_idx ON outbox_events (created_at) WHERE published_at IS NULL;

-- Idempotency. A replay with a matching request hash returns the stored
-- response. A replay with a DIFFERENT hash is a 409, which catches genuine
-- client bugs instead of silently corrupting data.
CREATE TABLE idempotency_keys (
  org_id          uuid NOT NULL,
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status smallint,
  response_body   jsonb,
  state           text NOT NULL DEFAULT 'in_flight',  -- in_flight | complete
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days',
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

-- Upload batches that failed validation repeatedly. Surfaced on the register as
-- Sync Error so a manager can see it and support can inspect it, rather than
-- leaving a silent hole in the day's numbers.
CREATE TABLE sync_dead_letter (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id      uuid NOT NULL,
  device_id   uuid,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  payload     jsonb NOT NULL,
  error       text NOT NULL,
  attempts    smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid
);
CREATE INDEX sync_dead_letter_open_idx ON sync_dead_letter (org_id, created_at) WHERE resolved_at IS NULL;

-- Receipt number leases, for stores that require strictly sequential numbering.
-- Default numbering is composite (STORE-REGISTER-SEQ) and needs no server call.
CREATE TABLE receipt_number_leases (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL,
  store_id     uuid NOT NULL,
  register_id  uuid NOT NULL,
  range_start  bigint NOT NULL,
  range_end    bigint NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  exhausted_at timestamptz,
  FOREIGN KEY (register_id, org_id) REFERENCES registers (id, org_id) ON DELETE CASCADE,
  CONSTRAINT lease_range CHECK (range_end > range_start)
);
CREATE INDEX receipt_lease_register_idx ON receipt_number_leases (register_id, range_start);

-- -----------------------------------------------------------------------------
-- Feature flags
-- -----------------------------------------------------------------------------

CREATE TABLE feature_flags (
  key         text NOT NULL,
  org_id      uuid,                      -- null = platform default
  store_id    uuid,
  enabled     boolean NOT NULL DEFAULT false,
  rollout_pct smallint NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  note        text,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_scope_key ON feature_flags (
  key,
  COALESCE(org_id,   '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Flags that must ship in the OFF position. Delivery of regulated product is
-- gated behind legal review, not behind a deploy.
INSERT INTO feature_flags (key, enabled, note) VALUES
  ('delivery.enabled',            false, 'Requires counsel review of PACT Act and Texas delivery sale permits'),
  ('delivery.third_party',        false, 'Requires signed courier agreement covering the category'),
  ('online_store.enabled',        false, 'Phase 5'),
  ('payments.card_offline',       false, 'Store and forward. Owner accepts the risk explicitly per store.'),
  ('compliance.manager_override', false, 'Only where a rule marks itself overridable'),
  ('marketing.sms',               false, 'Phase 7'),
  ('edi.enabled',                 false, 'Phase 8');

-- -----------------------------------------------------------------------------
-- Seed: permission catalog and system roles
-- -----------------------------------------------------------------------------

INSERT INTO permissions (key, category, description) VALUES
  ('sale.create',             'register',  'Ring up a sale'),
  ('sale.void',               'register',  'Void a transaction'),
  ('sale.discount_line',      'register',  'Discount a single line'),
  ('sale.discount_cart',      'register',  'Discount an entire transaction'),
  ('sale.price_override',     'register',  'Override a price'),
  ('sale.tax_exempt',         'register',  'Mark a sale tax exempt'),
  ('sale.reprint',            'register',  'Reprint a receipt'),
  ('refund.create',           'register',  'Issue a refund'),
  ('refund.no_receipt',       'register',  'Refund without the original transaction'),
  ('drawer.open',             'cash',      'Open the cash drawer'),
  ('drawer.no_sale',          'cash',      'Open the drawer without a sale'),
  ('cash.session_open',       'cash',      'Open a cash session'),
  ('cash.session_close',      'cash',      'Close and count a cash session'),
  ('cash.paid_in_out',        'cash',      'Record paid in and paid out'),
  ('cash.drop',               'cash',      'Perform a cash drop or safe deposit'),
  ('inventory.view',          'inventory', 'View stock levels'),
  ('inventory.adjust',        'inventory', 'Adjust inventory'),
  ('inventory.count',         'inventory', 'Perform inventory counts'),
  ('inventory.transfer',      'inventory', 'Transfer stock between stores'),
  ('product.view_cost',       'catalog',   'See product cost'),
  ('product.view_margin',     'catalog',   'See margin and profit'),
  ('product.create',          'catalog',   'Create products'),
  ('product.update',          'catalog',   'Edit products'),
  ('product.bulk_update',     'catalog',   'Bulk edit products'),
  ('product.delete',          'catalog',   'Deactivate products'),
  ('purchasing.view',         'purchasing','View purchase orders'),
  ('purchasing.create',       'purchasing','Create purchase orders'),
  ('purchasing.receive',      'purchasing','Receive stock against a purchase order'),
  ('vendor.manage',           'purchasing','Manage vendors'),
  ('customer.view',           'crm',       'View customer records'),
  ('customer.manage',         'crm',       'Create and edit customers'),
  ('customer.export',         'crm',       'Export customer data'),
  ('employee.view',           'admin',     'View employees'),
  ('employee.manage',         'admin',     'Create and edit employees'),
  ('employee.timeclock_edit', 'admin',     'Edit time clock entries'),
  ('report.sales',            'reporting', 'Run sales reports'),
  ('report.financial',        'reporting', 'Run profit and cash reports'),
  ('report.loss_prevention',  'reporting', 'Run loss prevention reports'),
  ('report.export',           'reporting', 'Export report data'),
  ('compliance.manage',       'compliance','Manage compliance rules'),
  ('compliance.override',     'compliance','Override a compliance denial where permitted'),
  ('settings.store',          'admin',     'Manage store settings'),
  ('settings.org',            'admin',     'Manage organization settings'),
  ('settings.integrations',   'admin',     'Manage provider integrations'),
  ('audit.view',              'admin',     'View the audit log');

INSERT INTO roles (org_id, key, name, description) VALUES
  (NULL, 'owner',             'Owner',             'Full access'),
  (NULL, 'administrator',     'Administrator',     'Full access except organization billing'),
  (NULL, 'manager',           'Manager',           'Store operations, staff and reporting'),
  (NULL, 'shift_lead',        'Shift Lead',        'Register plus approvals and cash sessions'),
  (NULL, 'cashier',           'Cashier',           'Register only'),
  (NULL, 'inventory_manager', 'Inventory Manager', 'Catalog, stock and purchasing'),
  (NULL, 'marketing_manager', 'Marketing Manager', 'Customers and campaigns');

-- Owner and administrator get everything.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'cashier'
  AND p.key IN ('sale.create','sale.discount_line','sale.reprint',
                'drawer.open','cash.session_open','inventory.view','customer.view');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'shift_lead'
  AND (
    p.category IN ('register', 'cash')
    OR p.key IN ('inventory.view','inventory.count','customer.view','customer.manage')
  );

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'manager'
  AND p.key NOT IN ('settings.org','settings.integrations','compliance.manage');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'inventory_manager'
  AND (p.category IN ('inventory','catalog','purchasing') OR p.key = 'report.sales');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key = 'marketing_manager'
  AND (p.category = 'crm' OR p.key IN ('report.sales','report.export'));
