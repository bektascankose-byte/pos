-- Populate change_log.
--
-- The table, the cursor index, the watermark function and `GET /v1/sync/changes`
-- all existed already. Nothing ever wrote a row, so the feed was a skeleton: a
-- register asking what changed was always told "nothing", and the only way to
-- learn about a price change was to pull the whole catalog again. This is the
-- part that was missing.
--
-- One trigger function for every replicated table, parameterised by entity type
-- and primary key column, rather than one function per table. Fifteen
-- near-identical functions drift, and the way they drift is that one of them
-- quietly stops logging and a register stops hearing about a category nobody
-- can explain.

CREATE OR REPLACE FUNCTION log_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  entity_type text := TG_ARGV[0];
  id_column   text := COALESCE(TG_ARGV[1], 'id');
  -- Columns whose change means nothing to a register.
  --
  -- `updated_at` is in here for every table, not per table, because a `_touch`
  -- trigger bumps it on every single update. Leaving it in means no two
  -- versions of a row ever compare equal, so the suppression below never fires
  -- and the hash changes even when the content did not — which would make the
  -- hash useless for the one job it has.
  ignored     text[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',')
                        || ARRAY['updated_at'];
  row_json    jsonb;
  before_json jsonb;
  column_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;

  -- Bookkeeping columns are stripped before anything else, so they affect
  -- neither the hash nor the decision to log at all.
  --
  -- `users.last_login_at` is the per-table one that matters. Every sign-in
  -- writes it, and without this every sign-in would mark the whole `employees`
  -- scope dirty for every register in the store — a false positive on the most
  -- frequent write in the system, on the very feed that exists to avoid
  -- pointless refetching.
  FOREACH column_name IN ARRAY ignored LOOP
    IF column_name <> '' THEN
      row_json := row_json - column_name;
    END IF;
  END LOOP;

  -- An update that changed nothing a register can see is not a change.
  IF TG_OP = 'UPDATE' THEN
    before_json := to_jsonb(OLD);
    FOREACH column_name IN ARRAY ignored LOOP
      IF column_name <> '' THEN
        before_json := before_json - column_name;
      END IF;
    END LOOP;
    IF before_json = row_json THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Platform scoped rows — the shared roles every organization uses — have no
  -- org_id. They change with a deploy, not at a counter, and change_log.org_id
  -- is NOT NULL, so logging them would fail the insert rather than inform
  -- anybody.
  IF row_json ->> 'org_id' IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO change_log (org_id, store_id, entity_type, entity_id, op, payload_hash)
  VALUES (
    (row_json ->> 'org_id')::uuid,
    -- Read out of the row rather than named per table: some replicated tables
    -- are store scoped and some are not, and `to_jsonb` gives a uniform way to
    -- ask without a column list that has to be kept in step with the schema.
    (row_json ->> 'store_id')::uuid,
    entity_type,
    (row_json ->> id_column)::uuid,
    lower(TG_OP)::change_op,
    -- The whole row, so any change at all produces a different hash. The
    -- register uses this to skip a fetch for a version it already holds, which
    -- is the common case when two registers in one store sync seconds apart.
    md5(row_json::text)
  );

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION log_change() IS
  'Writes a change_log notification. Arguments: entity_type; optionally the '
  'primary key column when it is not "id"; optionally a comma separated list of '
  'columns to ignore, which are excluded from the hash and suppress the row '
  'entirely when they are all that changed.';

-- The replicated tables, and only those.
--
-- `inventory_levels` is deliberately absent. It changes on every line of every
-- sale at every register, so tracking it would make the feed almost entirely
-- inventory churn — and the register treats stock as advisory rather than
-- authoritative: it is shown so a cashier can answer "have we got more", and it
-- explicitly does not gate a sale. Paying that volume to keep a number the
-- register will not act on current is the wrong trade. Stock arrives with the
-- bootstrap snapshot.

CREATE TRIGGER log_change_products
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION log_change('product');

CREATE TRIGGER log_change_product_variants
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION log_change('product_variant');

CREATE TRIGGER log_change_variant_barcodes
  AFTER INSERT OR UPDATE OR DELETE ON variant_barcodes
  FOR EACH ROW EXECUTE FUNCTION log_change('variant_barcode');

CREATE TRIGGER log_change_categories
  AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION log_change('category');

CREATE TRIGGER log_change_brands
  AFTER INSERT OR UPDATE OR DELETE ON brands
  FOR EACH ROW EXECUTE FUNCTION log_change('brand');

CREATE TRIGGER log_change_variant_prices
  AFTER INSERT OR UPDATE OR DELETE ON variant_prices
  FOR EACH ROW EXECUTE FUNCTION log_change('variant_price');

CREATE TRIGGER log_change_tax_rates
  AFTER INSERT OR UPDATE OR DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION log_change('tax_rate');

CREATE TRIGGER log_change_product_compliance
  AFTER INSERT OR UPDATE OR DELETE ON product_compliance
  FOR EACH ROW EXECUTE FUNCTION log_change('product_compliance', 'product_id');

CREATE TRIGGER log_change_users
  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION log_change('user', 'id', 'last_login_at');

CREATE TRIGGER log_change_employee_pins
  AFTER INSERT OR UPDATE OR DELETE ON employee_pins
  FOR EACH ROW EXECUTE FUNCTION log_change('employee_pin', 'user_id');

CREATE TRIGGER log_change_registers
  AFTER INSERT OR UPDATE OR DELETE ON registers
  FOR EACH ROW EXECUTE FUNCTION log_change('register');

CREATE TRIGGER log_change_stores
  AFTER INSERT OR UPDATE OR DELETE ON stores
  FOR EACH ROW EXECUTE FUNCTION log_change('store');
