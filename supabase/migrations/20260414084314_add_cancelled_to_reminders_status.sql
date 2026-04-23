-- Add 'cancelled' to the scheduled_reminders status check constraint.
-- The strategy watchdog uses 'cancelled' to distinguish reminders that were
-- intentionally stopped (strategy paused/completed) from those that finished
-- naturally ('completed') or errored ('failed').

ALTER TABLE scheduled_reminders
  DROP CONSTRAINT scheduled_reminders_status_check;

ALTER TABLE scheduled_reminders
  ADD CONSTRAINT scheduled_reminders_status_check
    CHECK (status = ANY (ARRAY['active', 'paused', 'completed', 'failed', 'cancelled']));
