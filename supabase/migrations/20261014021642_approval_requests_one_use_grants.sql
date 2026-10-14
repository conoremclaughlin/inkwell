-- One-use approval grants for destructive commands
-- (ink://specs/automated-turn-permissions §3.5).
--
-- A headless turn that meets a destructive command outside its own
-- directories asks Conor and is denied at once: it cannot wait, because the
-- runner's silence timeout is as long as the old poll. When he grants it,
-- the session is woken and runs the command again, and the hook spends the
-- grant. A grant is good once, for exactly the scope it was asked in.
--
-- scope_key: a digest of the request's scope, computed by the server from
--   the signed runner token's session (and that session's studio and SB)
--   plus the tool, the full command and the directory it runs in. Present
--   only on a one-use request, so it is also what marks one.
-- consumed_at: when the grant was spent. A consume is one conditional
--   update on `consumed_at IS NULL`, so two racing turns cannot both spend
--   it.
--
-- Both nullable; every existing row and every other request leaves them null.

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

CREATE INDEX IF NOT EXISTS approval_requests_unspent_grant_idx
  ON public.approval_requests (user_id, session_id, scope_key)
  WHERE scope_key IS NOT NULL AND status = 'granted' AND consumed_at IS NULL;
