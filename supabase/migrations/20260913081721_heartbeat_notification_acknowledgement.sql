-- Durable acknowledgement for heartbeat outage/recovery notices.
--
-- WHY THIS TABLE EXISTS.
--
-- The escalation path used to suppress a repeat alert on `consecutive > 1` —
-- the heartbeat failure streak. But a streak proves a previous BEAT failed; it
-- says nothing about whether that beat's outage alert ever reached a human. The
-- two are independent, and conflating them fails in the worst direction: if the
-- very first channel send rejects, its failure is already in `reminder_history`,
-- so every later beat reads `consecutive > 1` and stays quiet. Zero successful
-- alerts, forever, for an outage that is still happening. The recovery edge lost
-- its retry the same way.
--
-- So delivery acknowledgement is persisted separately from the streak. A notice
-- is suppressed only once it has actually been DELIVERED.
--
-- WHAT AN EPISODE IS, AND WHY IT IS MINTED RATHER THAN DERIVED.
--
-- `episode_key` identifies one outage. The first cut derived it from history:
-- the `triggered_at` of the oldest failure in the current contiguous run. That
-- is wrong in two ordinary cases, both found in review:
--
--   1. The first failure of an outage has no prior failure row to date it from,
--      so it fell back to an application timestamp — while the SECOND beat read
--      the first beat's `triggered_at` out of the database. Different value,
--      different text encoding. Two beats, two episode keys, two alarms for one
--      outage. No race required; this is the normal path.
--   2. Past the history lookback window the oldest visible failure shifts every
--      tick, so a long outage's key moved on every beat.
--
-- The key is therefore MINTED once, as a uuid, on the first failure of an
-- episode, and read back from this table on every subsequent beat. A value we
-- assign and store cannot drift the way a derived one does.
--
-- `episode_closed_at` is set on the OUTAGE row when that episode's all-clear is
-- delivered. It is what makes an owed recovery reconstructible: if we told
-- someone their monitor was down, we owe them a "it is back", and that
-- obligation must survive the recovery row failing to be written at all.
--
-- WHY THERE IS NO 'exhausted' STATUS.
--
-- There was one: after three failed attempts a notice stopped retrying and
-- became a log line. Review rejected it, correctly — permanently giving up on
-- telling a human their monitor is down is the exact failure this table exists
-- to prevent, and a cap converts a long channel outage into silence. Retry
-- FREQUENCY is bounded instead, via `next_attempt_at` backoff, while
-- eligibility is retained forever. A notice is either delivered or still owed.

CREATE TABLE heartbeat_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES scheduled_reminders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,

  -- Which edge of the outage this notice announces.
  kind text NOT NULL CHECK (kind IN ('outage', 'recovery')),

  -- The outage this notice belongs to: a minted uuid, stable for the life of
  -- the episode. See the note above for why it is not derived from history.
  episode_key text NOT NULL,

  -- Who it was meant to reach: '<sb_id>|<channel>|<target>'. Null when the beat
  -- has no owning SB, which leaves it deduplicating on its own episode alone.
  destination text,

  -- pending   — still owed. Eligible for retry once `next_attempt_at` passes.
  -- delivered — a notice for this episode reached the destination. Suppress.
  --             Also set when a SIBLING beat's notice covered the same
  --             destination in the same run: the human was told, which is the
  --             thing that matters.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),

  -- How many beats the episode had failed when this notice was composed.
  -- Carried on the row because a retried all-clear is sent from a later, healthy
  -- beat where the streak is already back to zero — without this the retry could
  -- only say "recovered after 0 failed beats", which is the one thing it is not.
  failed_beats integer NOT NULL DEFAULT 0,

  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_attempt_at timestamp with time zone,

  -- Backoff gate. A pending notice is eligible again once now() passes this.
  -- Null means eligible immediately.
  next_attempt_at timestamp with time zone,

  delivered_at timestamp with time zone,

  -- Set on the OUTAGE row when this episode's all-clear has been delivered.
  -- Null on an outage row means the episode is still open: either still failing,
  -- or recovered without the human having been told yet.
  episode_closed_at timestamp with time zone,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  -- One notice per edge per episode. This is the constraint the whole design
  -- leans on: it makes "have we already announced this outage" a lookup rather
  -- than an inference from the streak.
  UNIQUE (reminder_id, kind, episode_key)
);

-- The hot path: "is there a notice for this reminder+kind+episode".
-- Covered by the unique constraint's index.

-- Two sweeps run without knowing an episode key, so each needs its own index.
-- Finding the open episode on a failing beat, and finding an outage whose
-- all-clear is still owed on a healthy one:
CREATE INDEX idx_heartbeat_notifications_open_episode
  ON heartbeat_notifications (reminder_id, kind, created_at DESC)
  WHERE episode_closed_at IS NULL;

-- Retrying a pending notice of either kind:
CREATE INDEX idx_heartbeat_notifications_pending
  ON heartbeat_notifications (reminder_id, kind, status, created_at DESC);

CREATE TRIGGER update_heartbeat_notifications_updated_at
  BEFORE UPDATE ON heartbeat_notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE heartbeat_notifications ENABLE ROW LEVEL SECURITY;

-- Written exclusively by the server under the service role, which bypasses RLS.
-- Mirrors the sibling table `reminder_history`: service role gets full access,
-- and a user may read the notices belonging to their own reminders.
CREATE POLICY "Service role full access to heartbeat_notifications" ON heartbeat_notifications
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can view own heartbeat notifications" ON heartbeat_notifications
FOR SELECT
USING (reminder_id IN ( SELECT scheduled_reminders.id FROM scheduled_reminders WHERE (scheduled_reminders.user_id = auth.uid())));
