-- =============================================================================
-- 0024_outbox_and_webhooks.sql
--
-- The two halves of talking to the outside world without losing anything.
--
-- OUTBOUND. `outbox_events` has been here since 0001 and has never been
-- written to. Its comment there already states the contract this build
-- depends on -- "written here inside the business transaction… the only way
-- 'sale committed' and 'sale event published' cannot diverge" -- so this
-- migration extends that table rather than adding a second one beside it.
-- Three columns were missing for the storefront's needs:
--
--   * `available_at` makes exponential backoff a scheduling fact rather than
--     a timer somewhere in application memory that a restart forgets.
--   * `dead_at` separates "not published yet" from "gave up". Without it the
--     pending index is the graveyard too, and a permanently broken handler
--     buries every event behind it while telling nobody.
--   * `correlation_id` is what makes one customer's order traceable from the
--     storefront click, through the API and the register, to the courier's
--     webhook.
--
-- 0001 says events are "relayed to Redis". They are not, yet: the relay reads
-- this table directly and calls in-process handlers. Claiming with
-- `FOR UPDATE SKIP LOCKED` means moving that relay into its own process later
-- is a deployment change, not a rewrite.
--
-- INBOUND. `webhook_events` is genuinely new. Every courier, processor and
-- verification vendor in existence will send the same webhook twice, out of
-- order, and occasionally from someone else pretending to be them. So each
-- one is recorded on arrival with its signature already checked, deduplicated
-- on the provider's own event id, and processed from the stored row rather
-- than from the live request.
-- =============================================================================

ALTER TABLE outbox_events
  ADD COLUMN available_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dead_at        timestamptz,
  ADD COLUMN correlation_id text;

-- The claim query, and the only index here that has to be fast. Replaces
-- 0001's `outbox_pending_idx`, which could not express "due yet" or exclude
-- what has been given up on.
DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_claim_idx ON outbox_events (available_at, id)
  WHERE published_at IS NULL AND dead_at IS NULL;

-- "What happened to this order?", for support and for the timeline the POS
-- shows staff.
CREATE INDEX outbox_aggregate_idx
  ON outbox_events (org_id, aggregate_type, aggregate_id, created_at);

-- Anything stuck has to be findable without scanning the table.
CREATE INDEX outbox_dead_idx ON outbox_events (org_id, created_at DESC)
  WHERE dead_at IS NOT NULL;

-- -----------------------------------------------------------------------------

CREATE TYPE webhook_status AS ENUM ('received', 'processed', 'failed', 'ignored');

CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  -- NOT NULL on purpose. The signing secret belongs to the organization, so
  -- there is no way to check a signature without first knowing whose endpoint
  -- was hit. A payload whose owner cannot be established is not a webhook this
  -- system has any business storing; it is refused at the door rather than
  -- accumulating as unattributable rows nobody can read under RLS.
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,

  provider           text NOT NULL,          -- 'doordash' | 'nmi' | 'veratad'
  -- The provider's own id for this event, when it sends one. The dedup key:
  -- the same event arriving twice is the normal case, not an anomaly.
  provider_event_id  text,
  event_type         text,

  -- False is still recorded. A payload that failed signature verification is
  -- exactly what an investigation needs to see, and refusing to store it would
  -- erase the evidence of someone probing the endpoint. Nothing is ever
  -- processed from a row where this is false.
  signature_verified boolean NOT NULL DEFAULT false,

  -- The provider's body as received, for troubleshooting, subject to the
  -- retention policy in docs/SECURITY.md. It can carry a delivery address or a
  -- courier's phone number, so it is read through the API's masking rules and
  -- never copied into application logs.
  payload            jsonb NOT NULL,

  status             webhook_status NOT NULL DEFAULT 'received',
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,

  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,

  CONSTRAINT webhook_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT webhook_processed_at_set CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);

-- Deduplication. A provider that resends an event it already sent gets one
-- row, and the second delivery is answered 200 without doing the work twice.
-- Partial, because a provider that sends no event id still gets rows stored.
CREATE UNIQUE INDEX webhook_provider_event_key
  ON webhook_events (org_id, provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX webhook_pending_idx ON webhook_events (received_at)
  WHERE status IN ('received', 'failed');
CREATE INDEX webhook_provider_idx ON webhook_events (org_id, provider, received_at DESC);

-- RLS: 0005 enabled this for every org_id-bearing table that existed at the
-- time. A table created afterward has to opt in the same way, by hand.
-- `outbox_events` already has its policy from 0005 and needs nothing here.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON webhook_events
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

INSERT INTO permissions (key, category, description) VALUES
  ('integration.view',   'integration', 'View integration events and delivery failures'),
  ('integration.manage', 'integration', 'Retry or discard failed integration events')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.org_id IS NULL AND r.key IN ('owner', 'administrator')
  AND p.key IN ('integration.view', 'integration.manage')
ON CONFLICT DO NOTHING;

-- A manager can see that something is stuck without being able to discard it.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'integration.view' FROM roles r
WHERE r.org_id IS NULL AND r.key = 'manager'
ON CONFLICT DO NOTHING;
