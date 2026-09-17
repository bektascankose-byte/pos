-- =============================================================================
-- 0029_outbox_pump_functions.sql
--
-- The outbox pump could never see the outbox.
--
-- The pump serves every organization, so it runs with no `app.org_id` set --
-- and `outbox_events`, like every tenant table, is under row level security
-- that fails closed when no organization is set. Connected as `snappos_app`,
-- the role the API actually uses, its claim query matched nothing, forever. It
-- looked healthy, raised nothing, and delivered nothing; the tests that proved
-- it worked in 0024 connected as the migrator, which bypasses row level
-- security on every table.
--
-- The fix is the one this schema already uses for the other reads that are
-- cross-tenant by necessity (`auth_lookup_user`, `shop_lookup_client`): three
-- definer functions that do exactly what the pump needs and nothing more --
-- claim a batch, mark one delivered, mark one failed -- rather than a policy
-- loosened for everyone, or a pump that connects as a role that bypasses
-- security on everything.
--
-- Nothing a tenant can reach changes. `snappos_app` still cannot read another
-- organization's events; it can only ask the pump's three questions.
-- =============================================================================

CREATE OR REPLACE FUNCTION outbox_claim(p_limit integer, p_visibility_seconds integer)
RETURNS TABLE (
  id             uuid,
  org_id         uuid,
  event_type     text,
  aggregate_type text,
  aggregate_id   uuid,
  payload        jsonb,
  correlation_id text,
  attempts       integer
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- Claimed with a visibility timeout rather than marked in flight: a pump that
  -- dies holding a batch gives it back when the timeout passes, and SKIP LOCKED
  -- keeps two pumps from ever taking the same event.
  UPDATE outbox_events e
     SET attempts = e.attempts + 1,
         available_at = now() + make_interval(secs => p_visibility_seconds)
   WHERE e.id IN (
     SELECT o.id FROM outbox_events o
     WHERE o.published_at IS NULL AND o.dead_at IS NULL AND o.available_at <= now()
     ORDER BY o.available_at, o.id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
   )
  RETURNING e.id, e.org_id, e.event_type, e.aggregate_type, e.aggregate_id,
            e.payload, e.correlation_id, e.attempts::integer;
$fn$;

CREATE OR REPLACE FUNCTION outbox_mark_delivered(p_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = p_id;
$fn$;

-- A failure either schedules another try or, with `p_dead`, gives up and
-- parks the event where the dead-letter view finds it. The caller decides
-- which, because the retry policy lives with the pump, not in SQL.
CREATE OR REPLACE FUNCTION outbox_mark_failed(p_id uuid, p_error text, p_retry_in_seconds integer, p_dead boolean)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE outbox_events
     SET last_error   = p_error,
         dead_at      = CASE WHEN p_dead THEN now() ELSE dead_at END,
         available_at = CASE WHEN p_dead THEN available_at
                             ELSE now() + make_interval(secs => p_retry_in_seconds) END
   WHERE id = p_id;
$fn$;

REVOKE EXECUTE ON FUNCTION outbox_claim(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION outbox_mark_delivered(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION outbox_mark_failed(uuid, text, integer, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'snappos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION outbox_claim(integer, integer) TO snappos_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION outbox_mark_delivered(uuid) TO snappos_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION outbox_mark_failed(uuid, text, integer, boolean) TO snappos_app';
  END IF;
END $$;

COMMENT ON FUNCTION outbox_claim(integer, integer) IS
  'Cross tenant by necessity: the outbox pump serves every organization. '
  'Claims a batch with a visibility timeout; returns only what a handler needs.';
