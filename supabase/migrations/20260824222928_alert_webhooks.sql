-- General alerting infrastructure: sources, events, outbound webhooks.
--
-- Context: on 2026-08-24 the Docker filesystem filled and took down inkwell,
-- inkread AND inktrade together. Conor asked for an alert webhook that is
-- explicitly NOT an inkwell feature, notifies him AND the SBs, and is driven
-- by a checker that does not invoke an LLM.
--
-- The no-LLM constraint is load-bearing, not a cost note. When the box is out
-- of disk, the LLM path is the first thing to fail: sessions do not spawn and
-- triggers die, so the agent that would raise the alarm is the thing that is
-- broken. A monitor that needs an LLM cannot report the outage that matters
-- most. Hence: dumb script -> HTTP POST -> this schema.
--
-- Three tables, one for each half of the problem:
--
--   alert_sources  liveness. A source that stops reporting is itself an
--                  alertable condition. A state with no age is not a signal
--                  -- silence and health are indistinguishable without it.
--   alert_events   deduped alert instances, so a 5-minute cron raising the
--                  same condition does not send 288 notifications a day.
--   alert_webhooks outbound endpoints. This is the "webhooks as
--                  infrastructure" half: alerts fan out to registered URLs,
--                  not just to our own channels.

-- ── Severity ranking ────────────────────────────────────────────────────
--
-- Ordered so an escalation (warning -> critical) can re-notify immediately
-- rather than waiting out the cooldown of the lesser alert.

CREATE FUNCTION public.alert_severity_rank(p_severity text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_severity
    WHEN 'critical' THEN 3
    WHEN 'warning'  THEN 2
    WHEN 'info'     THEN 1
    ELSE 0
  END;
$$;

-- ── Sources ─────────────────────────────────────────────────────────────

CREATE TABLE public.alert_sources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Stable slug the checker identifies itself by, e.g. 'disk-monitor'.
  source text NOT NULL,
  description text,
  -- How often this source promises to check in. NULL means "no promise" --
  -- such a source can never be judged stale, which is a deliberate opt-out
  -- rather than a default.
  expected_interval_seconds integer
    CHECK (expected_interval_seconds IS NULL OR expected_interval_seconds > 0),
  -- Grace multiplier before silence counts as stale. A source promising 300s
  -- is only stale after 300 * 2 = 600s, so one missed run is not an outage.
  staleness_grace_factor numeric NOT NULL DEFAULT 2.0
    CHECK (staleness_grace_factor >= 1.0),
  last_seen_at timestamptz,
  last_status text CHECK (last_status IS NULL OR last_status IN ('ok', 'alerting')),
  last_detail text,
  -- Set when the staleness sweep has already raised the alarm for this
  -- source, so it raises once per silence rather than once per sweep.
  stale_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source)
);

CREATE INDEX alert_sources_liveness_idx
  ON public.alert_sources (last_seen_at)
  WHERE expected_interval_seconds IS NOT NULL;

CREATE TRIGGER alert_sources_updated_at
  BEFORE UPDATE ON public.alert_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ── Events ──────────────────────────────────────────────────────────────

CREATE TABLE public.alert_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title text NOT NULL,
  detail text,
  -- Identifies the *condition*, not the occurrence. Repeated posts of the
  -- same condition collapse onto one open row.
  dedupe_key text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz,
  occurrence_count integer NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  -- What actually went out, per sink, for after-the-fact debugging of a
  -- "why did nobody hear about this" question.
  delivery jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The dedupe contract: at most one OPEN event per condition per user.
-- Resolved events are history and do not participate, so the same condition
-- recurring after recovery opens a fresh row with its own first_seen_at.
CREATE UNIQUE INDEX alert_events_open_dedupe_idx
  ON public.alert_events (user_id, dedupe_key)
  WHERE resolved_at IS NULL;

CREATE INDEX alert_events_user_recent_idx
  ON public.alert_events (user_id, created_at DESC);

CREATE INDEX alert_events_open_idx
  ON public.alert_events (user_id, severity, last_seen_at DESC)
  WHERE resolved_at IS NULL;

-- ── Outbound webhook registry ───────────────────────────────────────────

CREATE TABLE public.alert_webhooks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL CHECK (url ~ '^https?://'),
  -- Shared secret for HMAC-SHA256 request signing. Receivers verify the
  -- X-Ink-Signature header rather than trusting the payload's own claims.
  secret text NOT NULL,
  -- Empty array means "no filter" (all severities / all sources).
  severities text[] NOT NULL DEFAULT ARRAY[]::text[],
  sources text[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled boolean NOT NULL DEFAULT true,
  last_delivery_at timestamptz,
  last_delivery_status integer,
  last_delivery_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX alert_webhooks_enabled_idx
  ON public.alert_webhooks (user_id)
  WHERE enabled;

CREATE TRIGGER alert_webhooks_updated_at
  BEFORE UPDATE ON public.alert_webhooks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ── Atomic ingest ───────────────────────────────────────────────────────
--
-- Deliberately a single INSERT ... ON CONFLICT rather than a SELECT followed
-- by an INSERT or UPDATE. The read-then-write shape is the exact race fixed
-- in #536: the read cannot see another transaction's uncommitted row, so two
-- concurrent posts of the same condition would both decide "no open event
-- exists" and the second insert would be refused by the partial unique index.
-- Two checkers posting the same alarm at once is ordinary, not exotic.
--
-- The notify decision is computed inside the UPDATE for the same reason. It
-- relies on now() being stable within a transaction: if the CASE chooses to
-- notify it writes now(), so `last_notified_at = now()` in the RETURNING
-- clause distinguishes "we just notified" from "we kept the old timestamp"
-- without a second read.

-- Optional parameters carry defaults so callers may omit them entirely rather
-- than passing an explicit null. Required params come first, as postgres
-- demands; supabase calls by name, so the reordering is invisible to callers.
CREATE FUNCTION public.ingest_alert_event(
  p_user_id uuid,
  p_source text,
  p_severity text,
  p_title text,
  p_dedupe_key text,
  p_detail text DEFAULT NULL,
  p_metrics jsonb DEFAULT '{}'::jsonb,
  p_cooldown_seconds integer DEFAULT 3600
)
RETURNS TABLE (
  event_id uuid,
  is_new boolean,
  should_notify boolean,
  occurrence_count integer,
  first_seen_at timestamptz
)
LANGUAGE sql
AS $$
  INSERT INTO public.alert_events AS ae (
    user_id, source, severity, title, detail, dedupe_key, metrics,
    first_seen_at, last_seen_at, last_notified_at, occurrence_count
  )
  VALUES (
    p_user_id, p_source, p_severity, p_title, p_detail, p_dedupe_key,
    COALESCE(p_metrics, '{}'::jsonb),
    now(), now(), now(), 1
  )
  ON CONFLICT (user_id, dedupe_key) WHERE resolved_at IS NULL
  DO UPDATE SET
    source = EXCLUDED.source,
    severity = EXCLUDED.severity,
    title = EXCLUDED.title,
    detail = EXCLUDED.detail,
    metrics = EXCLUDED.metrics,
    last_seen_at = now(),
    occurrence_count = ae.occurrence_count + 1,
    last_notified_at = CASE
      -- Escalation always speaks, even mid-cooldown. A condition getting
      -- worse is new information; suppressing it is the failure mode the
      -- cooldown is not meant to cause.
      WHEN public.alert_severity_rank(EXCLUDED.severity)
           > public.alert_severity_rank(ae.severity) THEN now()
      WHEN ae.last_notified_at IS NULL THEN now()
      WHEN now() - ae.last_notified_at
           >= make_interval(secs => GREATEST(p_cooldown_seconds, 0)) THEN now()
      ELSE ae.last_notified_at
    END
  RETURNING
    ae.id,
    (ae.occurrence_count = 1),
    (ae.last_notified_at = now()),
    ae.occurrence_count,
    ae.first_seen_at;
$$;

-- ── Resolve ─────────────────────────────────────────────────────────────
--
-- Returns the row only when this call is the one that closed it, so recovery
-- is announced exactly once no matter how many "ok" posts arrive.

CREATE FUNCTION public.resolve_alert_event(
  p_user_id uuid,
  p_dedupe_key text
)
RETURNS TABLE (
  event_id uuid,
  severity text,
  title text,
  occurrence_count integer,
  first_seen_at timestamptz,
  was_notified boolean
)
LANGUAGE sql
AS $$
  UPDATE public.alert_events AS ae
  SET resolved_at = now()
  WHERE ae.user_id = p_user_id
    AND ae.dedupe_key = p_dedupe_key
    AND ae.resolved_at IS NULL
  RETURNING
    ae.id,
    ae.severity,
    ae.title,
    ae.occurrence_count,
    ae.first_seen_at,
    (ae.last_notified_at IS NOT NULL);
$$;

-- ── Webhook failure bookkeeping ─────────────────────────────────────────
--
-- consecutive_failures is a counter, so it is incremented in SQL rather than
-- read into the application and written back. The read-then-write version
-- loses increments whenever two deliveries fail at once, which is precisely
-- when a receiver is down and every delivery is failing together.

CREATE FUNCTION public.record_alert_webhook_failure(
  p_webhook_id uuid,
  p_error text DEFAULT NULL,
  p_status integer DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE public.alert_webhooks
  SET consecutive_failures = consecutive_failures + 1,
      last_delivery_at = now(),
      last_delivery_status = p_status,
      last_delivery_error = p_error
  WHERE id = p_webhook_id
  RETURNING consecutive_failures;
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- Service-role access only, consistent with the rest of the schema: the real
-- authorization boundary is the API server's auth middleware.

ALTER TABLE public.alert_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to alert_sources" ON public.alert_sources
  USING (true) WITH CHECK (true);

ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to alert_events" ON public.alert_events
  USING (true) WITH CHECK (true);

ALTER TABLE public.alert_webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to alert_webhooks" ON public.alert_webhooks
  USING (true) WITH CHECK (true);
