-- Notification access is private to its signed-in owner. The API authorizes
-- every request; client roles have no direct table or function privileges.
CREATE TABLE public.sb_notification_watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.agent_identities(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.inbox_threads(id) ON DELETE CASCADE,
  signin_id uuid NOT NULL REFERENCES public.mcp_tokens(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  selected_packages text[] NOT NULL CHECK (cardinality(selected_packages) BETWEEN 1 AND 50),
  device_time_ms bigint NOT NULL CHECK (device_time_ms BETWEEN 0 AND 8640000000000000),
  clock_offset_ms bigint NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  active_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  minute_start timestamptz NOT NULL DEFAULT clock_timestamp(),
  minute_count integer NOT NULL DEFAULT 0 CHECK (minute_count >= 0),
  day_start timestamptz NOT NULL DEFAULT clock_timestamp(),
  day_count integer NOT NULL DEFAULT 0 CHECK (day_count >= 0),
  CHECK (expires_at > active_since)
);

CREATE UNIQUE INDEX sb_notification_watchers_one_active
  ON public.sb_notification_watchers(signin_id, installation_id, recipient_id)
  WHERE status = 'active';
CREATE INDEX sb_notification_watchers_owner ON public.sb_notification_watchers(owner_id, workspace_id, created_at DESC);
CREATE INDEX sb_notification_watchers_active_owner ON public.sb_notification_watchers(owner_id)
  WHERE status = 'active';

CREATE TABLE public.sb_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watcher_id uuid NOT NULL REFERENCES public.sb_notification_watchers(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  package_name text NOT NULL CHECK (length(package_name) BETWEEN 1 AND 255),
  app_label text CHECK (length(app_label) <= 255),
  title text NOT NULL CHECK (length(title) <= 512),
  text text NOT NULL CHECK (length(text) <= 8192),
  device_posted_at_ms bigint NOT NULL CHECK (device_posted_at_ms BETWEEN 0 AND 8640000000000000),
  posted_at timestamptz NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (watcher_id, event_id)
);
CREATE INDEX sb_notification_events_expiry ON public.sb_notification_events(expires_at);
CREATE INDEX sb_notification_events_watcher ON public.sb_notification_events(watcher_id, received_at DESC, id);

ALTER TABLE public.sb_notification_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sb_notification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_notification_watchers, public.sb_notification_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sb_notification_watchers, public.sb_notification_events TO service_role;

-- Bind a grant to the actual mobile sign-in, not a claimed account. Binding,
-- selection and clock calibration are immutable: changed consent requires a new grant.
CREATE FUNCTION public.guard_notification_watcher() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  signin public.mcp_tokens%ROWTYPE;
  captured_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.owner_id, NEW.workspace_id, NEW.recipient_id, NEW.thread_id,
           NEW.signin_id, NEW.installation_id, NEW.selected_packages, NEW.device_time_ms, NEW.clock_offset_ms,
           NEW.token_digest, NEW.active_since, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.owner_id, OLD.workspace_id, OLD.recipient_id, OLD.thread_id,
           OLD.signin_id, OLD.installation_id, OLD.selected_packages, OLD.device_time_ms, OLD.clock_offset_ms,
           OLD.token_digest, OLD.active_since, OLD.expires_at, OLD.created_at)
       OR (OLD.status <> 'active' AND NEW.status = 'active')
       OR (OLD.status = 'revoked' AND NEW.status <> 'revoked') THEN
      RAISE EXCEPTION USING ERRCODE = 'NPA01', MESSAGE = 'notification_grant_immutable';
    END IF;
    RETURN NEW;
  END IF;

  -- Capacity is per owner, not per client-chosen installation or sign-in.
  -- Serialize creators on that owner before taking the sign-in lock. This
  -- matches account deletion's owner -> sign-in -> grant order and leaves
  -- the intake/logout sign-in -> grant order unchanged.
  PERFORM id FROM public.users WHERE id = NEW.owner_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  SELECT * INTO signin FROM public.mcp_tokens WHERE id = NEW.signin_id FOR SHARE;
  captured_now := clock_timestamp();
  IF NOT FOUND OR signin.user_id <> NEW.owner_id OR signin.client_id <> 'mobile'
     OR signin.expires_at <= captured_now THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  -- Expired active-state rows still occupy capacity until explicitly revoked
  -- or removed. This also bounds the active-first owner listing at every age.
  IF NEW.status = 'active' AND (
    SELECT count(*) FROM public.sb_notification_watchers
      WHERE owner_id = NEW.owner_id AND status = 'active'
  ) >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA08', MESSAGE = 'notification_grant_limit';
  END IF;
  -- API-side audience authorization also checks exact participants. This
  -- invariant prevents a grant bound to an unrelated SB or workspace even
  -- when another server writer neglects the application check.
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_identities
     WHERE id = NEW.recipient_id AND user_id = NEW.owner_id AND workspace_id = NEW.workspace_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.inbox_threads
     WHERE id = NEW.thread_id AND workspace_id = NEW.workspace_id
       AND metadata->'inklingConversation' = 'true'::jsonb
       AND (metadata->'inklingShared') IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA03', MESSAGE = 'notification_target_refused';
  END IF;
  IF array_position(NEW.selected_packages, NULL) IS NOT NULL
     OR cardinality(NEW.selected_packages) <> (SELECT count(DISTINCT p) FROM unnest(NEW.selected_packages) p)
     OR EXISTS (SELECT 1 FROM unnest(NEW.selected_packages) p
                 WHERE length(p) > 255 OR p !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA04', MESSAGE = 'notification_selection_invalid';
  END IF;
  -- Keep the server epoch at the same millisecond resolution as device time.
  -- This is an estimate, not evidence that the device clock is truthful.
  NEW.active_since := date_trunc('milliseconds', captured_now);
  NEW.clock_offset_ms := floor(extract(epoch FROM NEW.active_since) * 1000)::bigint - NEW.device_time_ms;
  NEW.created_at := captured_now;
  NEW.expires_at := LEAST(NEW.expires_at, signin.expires_at);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_notification_watcher() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_notification_watcher() TO service_role;
CREATE TRIGGER sb_notification_watchers_guard BEFORE INSERT OR UPDATE ON public.sb_notification_watchers
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_watcher();
CREATE TRIGGER sb_notification_watchers_updated_at BEFORE UPDATE ON public.sb_notification_watchers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Intake is one INSERT. The trigger holds the sign-in and grant while it
-- checks liveness, deduplicates and charges quota. A concurrent revoke or
-- logout must serialize with it; an application-side check alone cannot.
-- This is a writer invariant, not a second data-access API or a polling RPC.
CREATE FUNCTION public.guard_notification_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  grant_row public.sb_notification_watchers%ROWTYPE;
  signin public.mcp_tokens%ROWTYPE;
  existing_fingerprint text;
  signin_id uuid;
  captured_now timestamptz;
  v_minute_count integer;
  v_day_count integer;
  calibrated_ms bigint;
BEGIN
  SELECT w.signin_id INTO signin_id FROM public.sb_notification_watchers w WHERE w.id = NEW.watcher_id;
  -- Lock sign-in before grant, matching logout's cascading delete order.
  SELECT * INTO signin FROM public.mcp_tokens t WHERE t.id = signin_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  SELECT * INTO grant_row FROM public.sb_notification_watchers WHERE id = NEW.watcher_id FOR UPDATE;
  captured_now := clock_timestamp();
  IF NOT FOUND OR grant_row.status <> 'active' OR grant_row.expires_at <= captured_now
     OR signin.user_id <> grant_row.owner_id OR signin.client_id <> 'mobile'
     OR signin.expires_at <= captured_now THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  calibrated_ms := NEW.device_posted_at_ms + grant_row.clock_offset_ms;
  IF calibrated_ms < 0 OR calibrated_ms > 8640000000000000 THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA05', MESSAGE = 'notification_event_refused';
  END IF;
  NEW.posted_at := to_timestamp(calibrated_ms::double precision / 1000);
  IF NOT (NEW.package_name = ANY(grant_row.selected_packages))
     OR NEW.posted_at < grant_row.active_since
     OR NEW.posted_at > captured_now + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA05', MESSAGE = 'notification_event_refused';
  END IF;
  NEW.received_at := captured_now;
  NEW.expires_at := LEAST(NEW.posted_at, captured_now) + interval '7 days';
  IF NEW.expires_at <= captured_now THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA05', MESSAGE = 'notification_event_refused';
  END IF;
  SELECT fingerprint INTO existing_fingerprint FROM public.sb_notification_events
    WHERE watcher_id = NEW.watcher_id AND event_id = NEW.event_id;
  IF FOUND THEN
    IF existing_fingerprint <> NEW.fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = 'NPA06', MESSAGE = 'notification_event_conflict';
    END IF;
    RETURN NULL; -- Identical retry: no row, quota charge or renewed retention.
  END IF;
  v_minute_count := CASE WHEN grant_row.minute_start <= captured_now - interval '1 minute' THEN 0 ELSE grant_row.minute_count END;
  v_day_count := CASE WHEN grant_row.day_start <= captured_now - interval '1 day' THEN 0 ELSE grant_row.day_count END;
  IF v_minute_count >= 600 OR v_day_count >= 10000 THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA07', MESSAGE = 'notification_rate_limited';
  END IF;
  UPDATE public.sb_notification_watchers SET
    minute_start = CASE WHEN v_minute_count = 0 THEN captured_now ELSE minute_start END,
    minute_count = v_minute_count + 1,
    day_start = CASE WHEN v_day_count = 0 THEN captured_now ELSE day_start END,
    day_count = v_day_count + 1
    WHERE id = NEW.watcher_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_notification_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_notification_event() TO service_role;
CREATE TRIGGER sb_notification_events_guard BEFORE INSERT ON public.sb_notification_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_event();

-- Mutable owner rules are not consent authority. Append-only versions provide
-- both the current resource (highest revision) and an atomic change log.
-- No row means revision zero with no rules and therefore no automatic match.
CREATE TABLE public.sb_notification_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watcher_id uuid NOT NULL REFERENCES public.sb_notification_watchers(id) ON DELETE CASCADE,
  -- Validated against the grant's owner below; deletion cascades via watcher.
  -- A second users FK here would take an owner key-share lock AFTER sign-in
  -- and grant, inverting account deletion's owner -> sign-in -> grant order.
  actor_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (watcher_id, revision)
);
ALTER TABLE public.sb_notification_rule_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sb_notification_rule_versions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.sb_notification_rule_versions TO service_role;

CREATE FUNCTION public.guard_notification_rule_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  grant_row public.sb_notification_watchers%ROWTYPE;
  signin public.mcp_tokens%ROWTYPE;
  signin_id uuid;
  captured_now timestamptz;
BEGIN
  SELECT w.signin_id INTO signin_id FROM public.sb_notification_watchers w WHERE w.id = NEW.watcher_id;
  SELECT * INTO signin FROM public.mcp_tokens t WHERE t.id = signin_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  SELECT * INTO grant_row FROM public.sb_notification_watchers WHERE id = NEW.watcher_id FOR UPDATE;
  captured_now := clock_timestamp();
  IF NOT FOUND OR grant_row.status <> 'active' OR grant_row.expires_at <= captured_now
     OR signin.user_id <> grant_row.owner_id OR signin.client_id <> 'mobile'
     OR signin.expires_at <= captured_now OR NEW.actor_id <> grant_row.owner_id THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA02', MESSAGE = 'notification_access_inactive';
  END IF;
  IF jsonb_typeof(NEW.rules) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA04', MESSAGE = 'notification_rules_invalid';
  END IF;
  IF jsonb_array_length(NEW.rules) > 20 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.rules) rule
     WHERE (jsonb_typeof(rule->'packageName') = 'string'
       AND rule->>'packageName' = ANY(grant_row.selected_packages)) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'NPA04', MESSAGE = 'notification_rules_invalid';
  END IF;
  SELECT COALESCE(max(revision), 0) + 1 INTO NEW.revision
    FROM public.sb_notification_rule_versions WHERE watcher_id = NEW.watcher_id;
  NEW.created_at := captured_now;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_notification_rule_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_notification_rule_version() TO service_role;
CREATE TRIGGER sb_notification_rule_versions_guard BEFORE INSERT ON public.sb_notification_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_rule_version();
