-- Studio lease & occupancy (spec:trigger-studio-routing v11 §Occupancy, Phase 5)
--
-- A studio is a git worktree and can host exactly one work-thread at a time.
-- The lease jsonb is the authoritative occupancy record:
--   { sessionId, threadKey, agentId, acquiredAt, heartbeatAt, reason }
-- Acquire and release are programmatic — routing acquires at resolution,
-- release happens on session end / thread close / heartbeat expiry. The SB
-- voluntarily releasing is a bonus path, never the mechanism (Conor, 2026-08-13).
--
-- studios.session_id predates this and is NOT a lease: nothing acquires it
-- atomically, nothing releases it on crash, no routing tier consults it.
-- The lease column supersedes it for occupancy.

ALTER TABLE public.studios ADD COLUMN IF NOT EXISTS ephemeral boolean NOT NULL DEFAULT false;
ALTER TABLE public.studios ADD COLUMN IF NOT EXISTS parent_studio_id uuid REFERENCES public.studios (id) ON DELETE SET NULL;
ALTER TABLE public.studios ADD COLUMN IF NOT EXISTS lease jsonb;
ALTER TABLE public.studios ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS studios_lease_thread_idx
  ON public.studios ((lease ->> 'threadKey')) WHERE lease IS NOT NULL;
CREATE INDEX IF NOT EXISTS studios_lease_session_idx
  ON public.studios ((lease ->> 'sessionId')) WHERE lease IS NOT NULL;
CREATE INDEX IF NOT EXISTS studios_parent_idx
  ON public.studios (parent_studio_id) WHERE parent_studio_id IS NOT NULL;

-- Lease event log — answers Conor's four visibility questions from recorded
-- data: why was the studio grabbed (event=acquired, reason = routing tier),
-- how long was it held (acquired→released span, heldMs in detail), what was
-- happening on it (threadKey/sessionId join), and how was it let go
-- (released/expired/reclaimed + final branch/commit state in detail).
-- Renewals are deliberately NOT logged — they would drown the signal.
CREATE TABLE public.studio_lease_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  studio_id uuid NOT NULL REFERENCES public.studios (id) ON DELETE CASCADE,
  session_id uuid,
  thread_key text,
  agent_id text,
  event text NOT NULL CHECK (event IN ('acquired', 'released', 'expired', 'reclaimed', 'overflow', 'conflict')),
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX studio_lease_events_studio_idx
  ON public.studio_lease_events (studio_id, created_at DESC);
CREATE INDEX studio_lease_events_thread_idx
  ON public.studio_lease_events (thread_key) WHERE thread_key IS NOT NULL;
CREATE INDEX studio_lease_events_user_idx
  ON public.studio_lease_events (user_id, created_at DESC);

ALTER TABLE public.studio_lease_events ENABLE ROW LEVEL SECURITY;

-- Service-role safety net, consistent with sibling tables: application-level
-- auth is the real boundary.
CREATE POLICY studio_lease_events_service ON public.studio_lease_events
  FOR ALL USING (true) WITH CHECK (true);
