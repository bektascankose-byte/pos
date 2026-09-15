-- =============================================================================
-- 0018_marketing.sql
--
-- Segments, campaigns, and the machinery that makes a send lawful.
--
-- The rule this migration exists to make structural: **a send that cannot
-- point at a consent row does not go out.** `customer_consents` has carried
-- that sentence since 0004; 0018 is where it stops being a comment. Every
-- recipient row records which of three things happened to it -- sent, failed,
-- or skipped with a reason -- so "who did we actually mail, and on what
-- basis" is answerable from the table rather than from logs.
--
-- Three tables and one function:
--
--   customer_segments     a saved, named question ("bought a vape in the last
--                         30 days"). Stored as jsonb rather than SQL, because
--                         a segment is data a user composes, and storing SQL
--                         someone can edit is storing an injection.
--   campaigns             one send: a segment, a channel, a subject, a body.
--   campaign_recipients   one row per person considered, including the ones
--                         skipped. A campaign that mailed 40 of 120 people
--                         should say why the other 80 were left out.
--   message_suppressions  addresses that must never be mailed again,
--                         regardless of consent -- an unsubscribe, a hard
--                         bounce, a complaint. Checked by address rather than
--                         by customer, because a bounce is a fact about the
--                         address and the same one can appear on two records.
--
-- `marketing_unsubscribe` is a SECURITY DEFINER function for the same reason
-- `auth_lookup_user` in 0007 is one: somebody clicking the unsubscribe link in
-- an email has no session and no organization context, so the one query that
-- finds their recipient row cannot be scoped to an org. The narrow function
-- with a fixed signature is the alternative to opening the tables.
-- =============================================================================

CREATE TABLE customer_segments (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  description  text,
  -- A structured filter the API validates and compiles, never free SQL.
  -- See `segmentDefinitionSchema` in packages/contracts.
  definition   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);

CREATE TRIGGER customer_segments_touch BEFORE UPDATE ON customer_segments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TYPE campaign_status AS ENUM ('draft', 'sending', 'sent', 'failed');

CREATE TABLE campaigns (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  channel           text NOT NULL,
  -- Nullable: a segment can be deleted after a campaign has gone out, and the
  -- campaign's own recipient rows are the record of who it reached.
  segment_id        uuid,
  subject           text,
  body              text NOT NULL,
  status            campaign_status NOT NULL DEFAULT 'draft',
  recipient_count   integer NOT NULL DEFAULT 0,
  sent_count        integer NOT NULL DEFAULT 0,
  failed_count      integer NOT NULL DEFAULT 0,
  -- Considered and deliberately not sent to: no consent, suppressed, or no
  -- address on the channel.
  skipped_count     integer NOT NULL DEFAULT 0,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  FOREIGN KEY (segment_id, org_id) REFERENCES customer_segments (id, org_id) ON DELETE SET NULL,
  UNIQUE (id, org_id),
  CONSTRAINT campaign_channel_known CHECK (channel IN ('email', 'sms')),
  -- An email needs a subject; a text message has no such thing.
  CONSTRAINT campaign_email_has_subject
    CHECK (channel <> 'email' OR (subject IS NOT NULL AND length(btrim(subject)) > 0)),
  CONSTRAINT campaign_sent_at_set CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX campaigns_org_idx ON campaigns (org_id, created_at DESC);

CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE campaign_recipients (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id              uuid NOT NULL,
  campaign_id         uuid NOT NULL,
  customer_id         uuid NOT NULL,
  -- The address as it was at send time. Kept rather than re-read from the
  -- customer, because "where did this actually go" must stay answerable after
  -- someone changes their email.
  address             text,
  status              text NOT NULL DEFAULT 'pending',
  -- Why a recipient was skipped, in words, so the campaign can explain itself.
  skip_reason         text,
  provider_message_id text,
  error               text,
  -- Unguessable, and specific to this one send, so an unsubscribe link ties
  -- back to the exact message that prompted it.
  unsubscribe_token   text NOT NULL,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, org_id) REFERENCES campaigns (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, org_id) REFERENCES customers (id, org_id) ON DELETE CASCADE,
  CONSTRAINT recipient_status_known
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  -- A skip without a reason is the thing this table exists to prevent.
  CONSTRAINT recipient_skip_has_reason
    CHECK (status <> 'skipped' OR skip_reason IS NOT NULL),
  UNIQUE (campaign_id, customer_id)
);

CREATE UNIQUE INDEX campaign_recipients_token_key ON campaign_recipients (unsubscribe_token);
CREATE INDEX campaign_recipients_campaign_idx ON campaign_recipients (campaign_id, status);
CREATE INDEX campaign_recipients_customer_idx ON campaign_recipients (customer_id, created_at DESC);

-- Never mail this address again, whatever any consent row says.
--
-- Separate from consent on purpose: consent is about a person's wishes, and a
-- suppression is about an address being unusable -- it bounced hard, or it
-- reported the mail as spam. Sending to either is how a shop loses its
-- sending reputation, so both are checked and a suppression wins.
CREATE TABLE message_suppressions (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  channel      text NOT NULL,
  address      text NOT NULL,
  reason       text NOT NULL,      -- 'unsubscribe' | 'bounce' | 'complaint' | 'manual'
  customer_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppression_channel_known CHECK (channel IN ('email', 'sms'))
);

CREATE UNIQUE INDEX message_suppressions_key
  ON message_suppressions (org_id, channel, lower(address));

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

ALTER TABLE customer_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON customer_segments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON campaigns
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON campaign_recipients
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE message_suppressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON message_suppressions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Unsubscribe
--
-- CAN-SPAM requires a working opt-out in every promotional email, and the
-- person clicking it is not signed in and never will be. Same shape as the
-- authentication lookups in 0007 and for the same reason: the one query that
-- has to run without an organization context is exposed as a narrow function
-- rather than by weakening a table's policy.
--
-- It does the whole job in one statement so a click cannot half-apply: append
-- a `granted: false` consent event, record a suppression for the address, and
-- return whether the token was real. Idempotent by construction -- clicking
-- twice appends a second revoke and hits the suppression's unique index,
-- which is harmless and still reports success, because a second click must
-- not show someone an error about an unsubscribe that already worked.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION marketing_unsubscribe(p_token text)
RETURNS TABLE (found boolean, channel text, address text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org       uuid;
  v_customer  uuid;
  v_channel   text;
  v_address   text;
BEGIN
  SELECT r.org_id, r.customer_id, c.channel, r.address
    INTO v_org, v_customer, v_channel, v_address
  FROM campaign_recipients r
  JOIN campaigns c ON c.id = r.campaign_id
  WHERE r.unsubscribe_token = p_token;

  IF v_org IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text;
    RETURN;
  END IF;

  INSERT INTO customer_consents (org_id, customer_id, channel, granted, source, evidence)
  VALUES (v_org, v_customer, v_channel, false, 'unsubscribe_link',
          jsonb_build_object('token', p_token));

  IF v_address IS NOT NULL THEN
    INSERT INTO message_suppressions (org_id, channel, address, reason, customer_id)
    VALUES (v_org, v_channel, v_address, 'unsubscribe', v_customer)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN QUERY SELECT true, v_channel, v_address;
END;
$fn$;

-- EXECUTE is revoked from PUBLIC first, the same as the authentication
-- lookups in 0007: a SECURITY DEFINER function is granted to PUBLIC by
-- default, which would make this callable by any future role.
REVOKE EXECUTE ON FUNCTION marketing_unsubscribe(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION marketing_unsubscribe(text) TO snappos_app';
  END IF;
END $$;

COMMENT ON FUNCTION marketing_unsubscribe(text) IS
  'Cross tenant by necessity: someone clicking an unsubscribe link has no session '
  'and no org context. Takes a per-recipient token and does nothing else.';

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------

INSERT INTO permissions (key, category, description) VALUES
  ('marketing.manage', 'crm', 'Create segments and draft campaigns'),
  ('marketing.send',   'crm', 'Send a campaign to customers')
ON CONFLICT (key) DO NOTHING;

-- 0001 granted "everything" to owner and administrator as a one-off insert, so
-- a permission added later has to be granted explicitly or those roles quietly
-- lack it.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('owner', 'administrator', 'marketing_manager')
  AND p.key IN ('marketing.manage', 'marketing.send')
ON CONFLICT DO NOTHING;

-- A manager may compose a campaign; sending one to the whole customer list is
-- deliberately a separate grant.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'marketing.manage'
FROM roles r
WHERE r.org_id IS NULL AND r.key = 'manager'
ON CONFLICT DO NOTHING;
