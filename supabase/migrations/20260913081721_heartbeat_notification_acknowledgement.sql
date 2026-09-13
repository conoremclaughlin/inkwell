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
-- is suppressed only once it has actually been DELIVERED; a pending one is
-- retried on the next beat, up to a bounded number of attempts so a permanently
-- dead channel cannot turn into an unbounded retry loop.
--
-- WHAT AN EPISODE IS.
--
-- `episode_key` identifies one outage: the `triggered_at` of the oldest failure
-- in the current contiguous run of failures. It is stable across every beat of
-- that outage, which is what makes "have we told them about THIS outage yet"
-- answerable. The recovery notice for an outage carries the same key, so the two
-- edges of one episode pair up.
--
-- It is deliberately not the streak COUNT: a count changes on every beat, so it
-- could never identify the episode it belongs to.

CREATE TABLE heartbeat_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES scheduled_reminders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,

  -- Which edge of the outage this notice announces.
  kind text NOT NULL CHECK (kind IN ('outage', 'recovery')),

  -- The outage this notice belongs to. See the note above.
  episode_key text NOT NULL,

  -- Who it was meant to reach: '<sb_id>|<channel>|<target>'. Null when the beat
  -- has no owning SB, which leaves it deduplicating on its own episode alone.
  destination text,

  -- pending   — not yet delivered; eligible for retry while under the cap.
  -- delivered — a notice for this episode reached the destination. Suppress.
  --             Also set when a SIBLING beat's notice covered the same
  --             destination in the same run: the human was told, which is the
  --             thing that matters.
  -- exhausted — attempts hit the cap without success. Stop retrying; the failure
  --             is in last_error and the guarded logger.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'exhausted')),

  -- How many beats the episode had failed when this notice was composed.
  -- Carried on the row because a retried all-clear is sent from a later, healthy
  -- beat where the streak is already back to zero — without this the retry could
  -- only say "recovered after 0 failed beats", which is the one thing it is not.
  failed_beats integer NOT NULL DEFAULT 0,

  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_attempt_at timestamp with time zone,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  -- One notice per edge per episode. This is the constraint the whole design
  -- leans on: it makes "have we already announced this outage" a lookup rather
  -- than an inference from the streak.
  UNIQUE (reminder_id, kind, episode_key)
);

-- The hot path: "is there a notice for this reminder+kind+episode".
-- Covered by the unique constraint's index.

-- The retry sweep on a healthy beat looks for a pending recovery notice without
-- knowing its episode, so it needs its own index.
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
