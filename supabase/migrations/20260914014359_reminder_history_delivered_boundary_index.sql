-- The episode boundary: the newest DELIVERED beat for one reminder.
--
-- Read on every beat, to decide whether an open outage episode belongs to the
-- run happening now or to one that already ended. Its query is
--
--   SELECT triggered_at FROM reminder_history
--    WHERE reminder_id = $1 AND status = 'delivered'
--    ORDER BY triggered_at DESC LIMIT 1
--
-- and without this index the planner has two poor options on a table that grows
-- by one row per beat forever. Filtering on `idx_reminder_history_reminder_id`
-- means sorting every row this reminder has ever written; scanning
-- `idx_reminder_history_triggered_at` backwards means walking past every row of
-- every OTHER reminder newer than the match. Both degrade with the length of the
-- outage, which is backwards — a long outage is when this lookup matters most.
--
-- Partial on `status = 'delivered'`: the query never asks for any other status,
-- and during an outage the failed rows are the overwhelming majority.
--
-- A separate file from the acknowledgement migration because that one is already
-- applied; editing it in place would be a silent no-op on any database that has
-- run it.
CREATE INDEX IF NOT EXISTS idx_reminder_history_delivered
  ON public.reminder_history (reminder_id, triggered_at DESC)
  WHERE status = 'delivered';
