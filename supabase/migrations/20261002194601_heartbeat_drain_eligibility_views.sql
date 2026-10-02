-- Eligibility for the held-notice drain, decided in SQL before any limit.
--
-- Lumen's review of PR #723 found both drain reads capping rows BEFORE
-- deciding which rows were eligible:
--   * the candidate read limited notices and only then removed all-clears
--     whose outage was still owed, so 200 blocked all-clears returned the
--     same 200 rows every tick and a newer due outage was never reached;
--   * the user read limited notice rows and only then deduplicated users, so
--     200 rows for one user could hide every other user.
-- "No all-clear ahead of its outage" needs NOT EXISTS, which PostgREST cannot
-- express in a filter. These views carry that rule, so the store's queries
-- can filter, order and limit over eligible rows only.
--
-- Views, not functions: each is one query, read through the same PostgREST
-- path as the table, with the caller's filters applied on top. Columns are
-- listed explicitly so a later change to the table cannot silently change
-- what the drain reads. security_invoker keeps the table's RLS in force for
-- any non-service caller.
--
-- An outage blocks its all-clear only when the drain can actually send that
-- outage (drain-owned, with a payload). A pending outage row with no payload
-- comes from before notices recorded their send; nothing will ever send it,
-- so waiting on it would be permanent silence. This matches
-- outageStatus() in heartbeat-notification-store.ts ('pending' vs 'stranded').

CREATE VIEW public.heartbeat_notifications_drain_users
  WITH (security_invoker = true) AS
  SELECT DISTINCT n.user_id
  FROM public.heartbeat_notifications n
  WHERE n.drain_owned
    AND n.status = 'pending'
    AND n.payload IS NOT NULL;

CREATE VIEW public.heartbeat_notifications_drain_eligible
  WITH (security_invoker = true) AS
  SELECT
    n.id,
    n.reminder_id,
    n.user_id,
    n.kind,
    n.episode_key,
    n.destination,
    n.failed_beats,
    n.payload,
    n.next_attempt_at,
    n.created_at
  FROM public.heartbeat_notifications n
  WHERE n.drain_owned
    AND n.status = 'pending'
    AND n.payload IS NOT NULL
    AND NOT (
      n.kind = 'recovery'
      AND EXISTS (
        SELECT 1
        FROM public.heartbeat_notifications o
        WHERE o.reminder_id = n.reminder_id
          AND o.episode_key = n.episode_key
          AND o.kind = 'outage'
          AND o.status <> 'delivered'
          AND o.drain_owned
          AND o.payload IS NOT NULL
      )
    );

-- Server-only reads, like the table itself.
REVOKE ALL ON public.heartbeat_notifications_drain_users FROM anon, authenticated;
REVOKE ALL ON public.heartbeat_notifications_drain_eligible FROM anon, authenticated;
GRANT SELECT ON public.heartbeat_notifications_drain_users TO service_role;
GRANT SELECT ON public.heartbeat_notifications_drain_eligible TO service_role;
