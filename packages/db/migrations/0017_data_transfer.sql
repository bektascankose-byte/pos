-- =============================================================================
-- 0017_data_transfer.sql
--
-- Importing a spreadsheet, and remembering how its columns were read.
--
-- Two kinds of file arrive at a shop like this: a one-time migration export
-- from the old system, and a vendor's price list that shows up again every
-- month in the same shape. They need opposite things. The migration is a
-- single enormous import where a wrong column mapping would corrupt the whole
-- catalog in one click, so nothing may be written until a human has seen what
-- the mapping would do. The monthly price list is the same layout over and
-- over, so being asked to re-map it every month is its own kind of failure.
--
-- `import_jobs` serves the first: an uploaded file sits here with its detected
-- headers and proposed mapping, and `dry_run` holds the counts and per-row
-- errors a reviewer reads before committing. `import_mappings` serves the
-- second: a mapping a human confirmed, keyed by the shape of the header row,
-- so the same sheet maps itself the next time.
--
-- The header hash is over the NORMALIZED header row (lowercased, punctuation
-- collapsed, in order), not the raw text -- "Unit Cost" and "unit_cost" are
-- the same sheet to anyone reading it, and should be the same sheet here.
-- Order is kept because two sheets with the same columns in a different order
-- genuinely are different layouts to a row parser.
--
-- Nothing here stores the file's contents. `source_object_key` points at
-- object storage, the same way `invoice_imports` does, so a large migration
-- file is not sitting in a jsonb column.
-- =============================================================================

CREATE TYPE import_entity AS ENUM ('item', 'customer');

-- `mapped` means a mapping exists but has not been dry run; `validated` means
-- a dry run has been done and its result is on the row. Commit is refused
-- from any state but `validated`, which is what makes the dry run mandatory
-- rather than merely offered.
CREATE TYPE import_job_status AS ENUM ('uploaded', 'mapped', 'validated', 'committed', 'failed');

CREATE TABLE import_jobs (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entity              import_entity NOT NULL,
  -- Which store's prices and stock an item import applies to. Null for
  -- customers, who are org-wide.
  store_id            uuid,
  source_object_key   text NOT NULL,
  source_filename     text NOT NULL,
  source_content_type text NOT NULL,
  source_format       text NOT NULL,   -- 'csv' | 'xlsx'
  header_hash         text NOT NULL,
  -- The header row exactly as read, so the review screen can show real column
  -- names rather than indexes.
  headers             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- field -> source column name. Written by the deterministic pass, widened
  -- by AI for whatever it could not place, and replaced wholesale by whatever
  -- the reviewer confirms.
  mapping             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which fields the AI tier supplied, so the review screen can mark those
  -- for a closer look. Never a reason to skip review -- just a hint.
  ai_mapped_fields    jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count           integer NOT NULL DEFAULT 0,
  status              import_job_status NOT NULL DEFAULT 'uploaded',
  -- The last dry run: counts, and the rows that would be skipped with why.
  dry_run             jsonb,
  error               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  committed_at        timestamptz,
  FOREIGN KEY (store_id, org_id) REFERENCES stores (id, org_id) ON DELETE RESTRICT,
  UNIQUE (id, org_id),
  CONSTRAINT import_job_format_known CHECK (source_format IN ('csv', 'xlsx')),
  CONSTRAINT import_job_row_count_sane CHECK (row_count >= 0),
  -- A committed job has a commit time and a validated mapping behind it; an
  -- uncommitted one has neither. Keeps "committed" from being a label that
  -- drifted away from the fact.
  CONSTRAINT import_job_committed_at_set
    CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);

CREATE INDEX import_jobs_org_idx ON import_jobs (org_id, created_at DESC);

CREATE TRIGGER import_jobs_touch BEFORE UPDATE ON import_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A mapping a human confirmed, for a header row shaped this way.
--
-- Keyed by header shape alone, deliberately not by vendor: two vendors whose
-- sheets carry the same columns in the same order are, to a row parser, the
-- same sheet, and the mapping that works for one works for the other. Adding
-- a vendor to the key would only split one correct memory into two.
CREATE TABLE import_mappings (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entity        import_entity NOT NULL,
  header_hash   text NOT NULL,
  -- Kept alongside the hash so a person can recognize the layout in a list,
  -- and so a hash collision would be visible rather than silent.
  headers       jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping       jsonb NOT NULL,
  label         text,
  use_count     integer NOT NULL DEFAULT 1 CHECK (use_count > 0),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity, header_hash)
);

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_jobs
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_mappings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Export permission
--
-- `customer.export` has existed since 0001 and gates customer data leaving the
-- system. The catalog had no equivalent: product.view lets someone read the
-- catalog a page at a time, which is not the same as walking out with the
-- whole thing including cost in one file. Cost is the reason -- an item export
-- carries it, and product.view_cost deliberately does not come with
-- product.view.
-- -----------------------------------------------------------------------------

INSERT INTO permissions (key, category, description) VALUES
  ('product.export', 'catalog', 'Export the product catalog to a file')
ON CONFLICT (key) DO NOTHING;

-- Anyone already trusted to bulk edit the catalog can export it; a bulk edit
-- is the more dangerous of the two.
INSERT INTO role_permissions (role_id, permission_key)
SELECT DISTINCT rp.role_id, 'product.export'
FROM role_permissions rp
WHERE rp.permission_key = 'product.bulk_update'
ON CONFLICT DO NOTHING;
