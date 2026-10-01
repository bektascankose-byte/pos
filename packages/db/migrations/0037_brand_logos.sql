-- =============================================================================
-- 0037_brand_logos.sql
--
-- A logo for each brand, so the brand folders on the till are recognisable at
-- a glance: a cashier looking for Foger finds the Foger logo faster than the
-- word. The AI draft finds one from the web when it names a brand, and the
-- back office can find, upload or remove one by hand.
--
-- Our own copy, never a link. The bytes live in object storage beside the
-- product photos and only the key is kept here, so a register that has
-- downloaded a logo keeps it for good, and nobody's CDN going away blanks the
-- folders on a till.
--
-- One logo per brand. Replacing one deletes the row and writes a new one with
-- a new id, which is what lets a logo be served as immutable: the address of
-- a logo never starts meaning a different picture.
--
-- Not held for Send to POS. A logo is how a folder looks, the same kind of
-- thing as a category's name, which registers already get without a Send. So
-- its change_log rows use their own entity type, 'brand_logo', which tells the
-- registers to pull straight away; edits to `brands` itself still wait.
-- =============================================================================

CREATE TABLE brand_logos (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id        uuid NOT NULL,
  brand_id      uuid NOT NULL,
  object_key    text NOT NULL,
  content_type  text NOT NULL
                CONSTRAINT brand_logo_image_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes         integer NOT NULL CONSTRAINT brand_logo_has_bytes CHECK (bytes > 0),
  -- The page or file it came from, when it came from the web. Kept so where a
  -- logo was taken from is always on record next to it.
  source_url    text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (brand_id, org_id) REFERENCES brands (id, org_id) ON DELETE CASCADE,
  UNIQUE (brand_id)
);

ALTER TABLE brand_logos ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON brand_logos
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

CREATE TRIGGER log_change_brand_logos
  AFTER INSERT OR UPDATE OR DELETE ON brand_logos
  FOR EACH ROW EXECUTE FUNCTION log_change('brand_logo');
