-- Turn epoch v3: a real column (Lumen, PR #563 round 5).
--
-- Living inside metadata made the epoch only as durable as the least careful
-- writer: every service-side read-modify-write rebuilds the whole JSONB blob,
-- so a stale full-blob write (a post-finalize token-usage checkpoint from
-- another process, a phase update racing a takeover) could replay epoch A
-- over B and invalidate every later CAS. A column closes the class: writers
-- only touch columns they name, the fence becomes a plain column predicate,
-- and metadata rewrites cannot brush against ownership at all.
--
-- claim_turn_epoch also grows atomic takeover semantics for the CLI hooks:
-- claim + lifecycle + turn marker in ONE statement, so a claim can no longer
-- succeed while the lifecycle write fails and leave ownership stolen without
-- a running state behind it.

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS turn_epoch text;

-- Live rows that carried the metadata epoch keep their ownership.
UPDATE public.sessions
SET turn_epoch = metadata ->> 'turnEpoch'
WHERE turn_epoch IS NULL AND metadata ? 'turnEpoch';

CREATE OR REPLACE FUNCTION public.handle_session_running_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A running session is not interrupted.
  NEW.metadata := (COALESCE(NEW.metadata, '{}'::jsonb) - 'interruptedAt') - 'interruptedReason';

  -- Fill an epoch only when entering running WITHOUT one. A provided value is
  -- the caller's ownership candidate and is never overridden.
  IF (TG_OP = 'INSERT' OR OLD.lifecycle IS DISTINCT FROM 'running')
     AND NEW.turn_epoch IS NULL THEN
    NEW.turn_epoch := gen_random_uuid()::text;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_running_write ON public.sessions;

CREATE TRIGGER session_running_write
  BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (NEW.lifecycle = 'running')
  EXECUTE FUNCTION public.handle_session_running_write();

-- Atomic ownership takeover. p_set_running additionally moves the session to
-- running and opens the CLI turn marker in the same statement — the prompt
-- takeover is all-or-nothing (Lumen round 5: claim-success/update-failure
-- must not steal ownership without a running state and marker behind it).
DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid);
CREATE OR REPLACE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
AS $$
  UPDATE public.sessions
  SET turn_epoch = gen_random_uuid()::text,
      lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
      cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END
  WHERE id = p_session_id
  RETURNING turn_epoch;
$$;

REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_session_running_write() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean) FROM anon, authenticated;
