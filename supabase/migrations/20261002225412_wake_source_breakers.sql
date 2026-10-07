-- No-progress breaker for automatic wake sources
-- (ink://specs/session-lifecycle-model §5, task T1).
--
-- A wake source (a strategy watchdog, graph dispatch, and later a reminder
-- whose purpose is work) wakes an SB to move a work item forward. PR #349's
-- loop was a watchdog that kept waking a session every ten minutes while the
-- task it watched never changed: the agent thought the work was done and the
-- task still said pending. This table counts that, per wake source and work
-- item, and never per session: one home session serves many sources, and a
-- source keeps its count across session changes.
--
-- One row per (user, source, work item, revision). A row counts completed,
-- admitted attempts whose turn ended with the work item's state unchanged
-- (`no_progress_count`). Progress is a change to the work item's state
-- fingerprint (task status, outcome, gate state; group status and task
-- statuses), never a message, a dispatch stamp or an activity row. At the
-- limit the row trips: the source stops waking for that item until its state
-- changes or the source is explicitly resumed. Human messages and explicit
-- replies never read this table.

CREATE TABLE IF NOT EXISTS public.wake_source_breakers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('strategy_watchdog', 'graph_dispatch', 'reminder_work')),
  work_kind text NOT NULL CHECK (work_kind IN ('task_group', 'task', 'graph_node')),
  work_id uuid NOT NULL,
  -- Empty when the work item has no revision. A new revision is a new item.
  revision text NOT NULL DEFAULT '',
  -- The group the item belongs to, so resuming a strategy or restarting a
  -- graph clears its rows in one statement.
  task_group_id uuid,
  -- The SB the source wakes; the trip notice is addressed to it.
  owner_sb_id uuid,

  no_progress_count integer NOT NULL DEFAULT 0 CHECK (no_progress_count >= 0),
  -- Completion time of the last counted attempt. An attempt dispatched before
  -- it was queued behind that attempt and is a duplicate, not a new attempt.
  last_counted_at timestamptz,
  -- The work item's fingerprint when the last counted attempt ended.
  last_fingerprint text,

  -- Set while tripped. Cleared by progress (a different fingerprint at the
  -- next admission) or an explicit reset.
  tripped_at timestamptz,
  tripped_fingerprint text,
  -- Kept after the trip clears, so a notice can say the same source tripped
  -- again within a day.
  last_tripped_at timestamptz,
  trip_count integer NOT NULL DEFAULT 0 CHECK (trip_count >= 0),
  last_notice_at timestamptz,

  -- Compare-and-set guard for concurrent completions.
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wake_source_breakers_key UNIQUE (user_id, source, work_id, revision)
);

CREATE INDEX IF NOT EXISTS wake_source_breakers_group_idx
  ON public.wake_source_breakers (task_group_id)
  WHERE task_group_id IS NOT NULL;

CREATE TRIGGER wake_source_breakers_updated_at
  BEFORE UPDATE ON public.wake_source_breakers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Server-only, like every table the API owns: the service role bypasses RLS,
-- and no client role reads or writes it.
ALTER TABLE public.wake_source_breakers ENABLE ROW LEVEL SECURITY;
