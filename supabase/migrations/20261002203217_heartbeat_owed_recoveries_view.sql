-- All-clears that are owed and that nothing durable holds, for the held-notice
-- drain to send without another reminder run.
--
-- Lumen's review of PR #723: an all-clear waits while its outage notice is
-- still owed (held over quiet hours, or its send failing). When the recovery
-- beat could not record its own claim, nothing durable held that all-clear.
-- The beat-path sweep that would rebuild it runs only on a later healthy beat,
-- and a reminder on its final run, or paused after recovering, has none: the
-- drain delivered the outage and the all-clear never came.
--
-- The debt is rebuilt from two records the recovery claim does not write:
--   * the outage notice: delivered, drain-owned, its episode still open;
--   * reminder_history: a delivered beat after the outage notice was created,
--     which is the episode ending. The beat path writes that row before it
--     announces the recovery.
-- An episode is left out only when its recovery row will be sent by something
-- else or already has been: delivered (sent, or covered by a sibling), or
-- drain-owned with a payload (the drain sends it). A recovery row with
-- neither, such as the empty row a failed settle recreates when the claim
-- had also failed, holds nothing, so the episode stays owed here; the claim
-- the rebuild makes gives that row its payload.
--
-- drain_owned limits this to notices that recorded their send. Outages from
-- before that are not swept here.
--
-- failed_beats counts the failed beats between the last delivered beat before
-- the outage and the one that ended it, never fewer than the outage recorded.

CREATE VIEW public.heartbeat_notifications_owed_recoveries
  WITH (security_invoker = true) AS
  SELECT
    o.id,
    o.reminder_id,
    o.user_id,
    o.episode_key,
    o.destination,
    ended.recovered_at,
    GREATEST(
      o.failed_beats,
      (
        SELECT count(*)::integer
        FROM public.reminder_history f
        WHERE f.reminder_id = o.reminder_id
          AND f.status = 'failed'
          AND f.triggered_at < ended.recovered_at
          AND f.triggered_at > COALESCE(
            (
              SELECT max(d.triggered_at)
              FROM public.reminder_history d
              WHERE d.reminder_id = o.reminder_id
                AND d.status = 'delivered'
                AND d.triggered_at < o.created_at
            ),
            '-infinity'::timestamptz
          )
      )
    ) AS failed_beats
  FROM public.heartbeat_notifications o
  CROSS JOIN LATERAL (
    SELECT min(h.triggered_at) AS recovered_at
    FROM public.reminder_history h
    WHERE h.reminder_id = o.reminder_id
      AND h.status = 'delivered'
      AND h.triggered_at > o.created_at
  ) ended
  WHERE o.kind = 'outage'
    AND o.status = 'delivered'
    AND o.drain_owned
    AND o.episode_closed_at IS NULL
    AND ended.recovered_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.heartbeat_notifications r
      WHERE r.reminder_id = o.reminder_id
        AND r.episode_key = o.episode_key
        AND r.kind = 'recovery'
        AND (r.status = 'delivered' OR (r.drain_owned AND r.payload IS NOT NULL))
    );

-- Server-only reads, like the table itself.
REVOKE ALL ON public.heartbeat_notifications_owed_recoveries FROM anon, authenticated;
GRANT SELECT ON public.heartbeat_notifications_owed_recoveries TO service_role;
