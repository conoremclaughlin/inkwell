-- A per-reminder switch to run during quiet hours, and the notice hold that
-- keeps an overnight failure from reaching the user's phone.
--
-- Conor, 2026-10-02: option B now (this), option C later (messages to the user
-- wait until morning, task df7cd1c2). Contract: task 2301cb3c; design in
-- ink://specs/addressed-reminders §8.
--
-- WHY THE NOTICE COLUMNS SHIP WITH THE SWITCH.
--
-- Quiet hours were enforced in two places: the reminder loop, which skips a
-- due reminder until the window ends, and alert-policy. Heartbeat escalation
-- never checked them, and never needed to while every failing beat was itself
-- held overnight. A reminder allowed to run at 3 AM can fail at 3 AM, and its
-- outage notice would go straight to the user's phone. So a notice that comes
-- due inside quiet hours is HELD, and a drain on the heartbeat tick sends it
-- once the window ends.
--
-- Two deadlines stay apart. `next_attempt_at` remains the channel-retry backoff
-- and is written only by a real send attempt. A hold never writes it: it
-- records why (`hold_reason`) and, for display, when the window was due to end
-- at the time (`held_until`). Eligibility is recomputed on every tick from the
-- CURRENT quiet-hours setting and the backoff, so disabling quiet hours at
-- 07:00 releases a notice held "until 08:00" on the next tick.
--
-- `drain_owned` marks a notice the drain is responsible for. It is set when a
-- notice first enters a hold and stays set until the notice is delivered,
-- through failed morning sends, their backoff and restarts. Without it a
-- one-time reminder's notice, held overnight and then failing its first
-- morning send, would fall back into a pending row that no beat will ever
-- retry, because the reminder has finished.
--
-- `payload` is what the direct send needs (channel, target, content), stored
-- when the notice is held so the drain never reruns the reminder or its
-- failure bookkeeping to reconstruct it.

ALTER TABLE scheduled_reminders
  ADD COLUMN run_during_quiet_hours boolean NOT NULL DEFAULT false;

ALTER TABLE heartbeat_notifications
  ADD COLUMN hold_reason text CHECK (hold_reason IN ('quiet-hours')),
  ADD COLUMN held_until timestamp with time zone,
  ADD COLUMN drain_owned boolean NOT NULL DEFAULT false,
  ADD COLUMN payload jsonb;

-- The drain's working set: undelivered notices it owns, oldest first, per user.
CREATE INDEX idx_heartbeat_notifications_drain
  ON heartbeat_notifications (user_id, created_at)
  WHERE drain_owned AND status = 'pending';
