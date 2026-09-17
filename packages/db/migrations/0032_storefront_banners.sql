-- =============================================================================
-- 0032_storefront_banners.sql
--
-- The pictures on the website that are not product photos: a brand's key
-- visual across the top of the home page, a feature strip, a banner over a
-- brand's own page.
--
-- Kept in the database with the bytes in object storage, the same split
-- product photos use, so a shop can change what its home page shows from the
-- back office when next month's media kit arrives -- rather than waiting on a
-- code change for a picture.
--
-- EVERY VAPE ADVERTISEMENT CARRIES THE WARNING. Federal rules require the
-- nicotine warning on advertising for these products, laid out a particular
-- way, and hold the retailer responsible even for artwork the manufacturer
-- made. `advertises_nicotine` is what makes the storefront draw that warning
-- around the banner; it defaults to true because the safe mistake is showing
-- the warning on something that did not need it.
--
-- A BANNER ONLY SHOWS WHAT CAN BE BOUGHT. With `hide_when_unavailable`, a
-- banner linking to a brand, category or product stays off the page while
-- nothing it points at is in stock online. Advertising the one thing a shopper
-- then cannot order is worse than advertising nothing.
-- =============================================================================

CREATE TYPE banner_placement AS ENUM (
  'home_hero',     -- the large banner at the top of the home page
  'home_feature',  -- the row of smaller banners further down it
  'brand_header'   -- across the top of a brand's own page
);

CREATE TABLE storefront_banners (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  placement             banner_placement NOT NULL,

  -- What staff call it in the back office. Not shown to shoppers.
  title                 text NOT NULL,
  -- Optional words set over or under the artwork, and the button's label.
  headline              text,
  body                  text,
  cta_label             text,

  -- Where it goes when clicked. A brand id, a category slug, a product id or a
  -- search, and for brand headers the brand whose page it heads.
  link_kind             text NOT NULL,
  link_value            text,

  -- Object storage keys, never shown to a browser. The wide image is required;
  -- a taller one for phones and a short silent video are optional.
  image_key             text NOT NULL,
  image_width           integer NOT NULL,
  image_height          integer NOT NULL,
  image_mobile_key      text,
  image_mobile_width    integer,
  image_mobile_height   integer,
  video_key             text,
  video_bytes           bigint,

  -- Read aloud by screen readers in place of the picture. Required, because a
  -- banner with no description is a blank to someone who cannot see it.
  alt_text              text NOT NULL,

  advertises_nicotine   boolean NOT NULL DEFAULT true,
  hide_when_unavailable boolean NOT NULL DEFAULT true,

  starts_at             timestamptz,
  ends_at               timestamptz,
  sort_order            smallint NOT NULL DEFAULT 0,
  status                entity_status NOT NULL DEFAULT 'active',

  -- Where the artwork came from, such as the media kit it was taken out of.
  source_note           text,

  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, org_id),
  CONSTRAINT banner_title_not_blank   CHECK (btrim(title) <> ''),
  CONSTRAINT banner_alt_not_blank     CHECK (btrim(alt_text) <> ''),
  CONSTRAINT banner_link_kind         CHECK (link_kind IN ('brand', 'category', 'product', 'search', 'none')),
  CONSTRAINT banner_link_has_value    CHECK (link_kind = 'none' OR btrim(COALESCE(link_value, '')) <> ''),
  CONSTRAINT banner_brand_header_link CHECK (placement <> 'brand_header' OR link_kind = 'brand'),
  CONSTRAINT banner_image_size        CHECK (image_width > 0 AND image_height > 0),
  CONSTRAINT banner_mobile_complete   CHECK (
    (image_mobile_key IS NULL) = (image_mobile_width IS NULL)
    AND (image_mobile_key IS NULL) = (image_mobile_height IS NULL)
  ),
  CONSTRAINT banner_window_ordered    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX storefront_banners_live_idx ON storefront_banners (org_id, placement, sort_order)
  WHERE status = 'active';

CREATE TRIGGER storefront_banners_touch BEFORE UPDATE ON storefront_banners
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE storefront_banners ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON storefront_banners
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
