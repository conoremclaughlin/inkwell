-- Two things the retry overlap needs from the database rather than from the
-- application: an authoritative rotation clock, and a revocation that is one
-- statement.

-- 1. `rotated_at` may never sit in the future.
--
-- The overlap is "the replaced secret stays redeemable for N seconds after the
-- rotation". Read in the application, that is `now - rotated_at <= N`, and a
-- stamp in the future makes the left side negative — so a row stamped a month
-- ahead satisfies a sixty-second window for a month. The application now
-- refuses a stamp more than a few seconds ahead, but the clock that wrote it is
-- the clock being doubted, so the bound belongs where neither a wrong API-server
-- clock nor a migrated row can get around it: the transaction's own now().
--
-- Clamping rather than rejecting is deliberate. The write itself is legitimate —
-- a rotation genuinely happened — and the only wrong part is a timestamp the
-- writer could not have known was skewed. Clamping records the rotation at the
-- earliest time the database can vouch for, which shortens the window and never
-- lengthens it. A raised exception would instead fail the exchange outright and
-- lock out a client for a server-side clock it has no part in.
CREATE OR REPLACE FUNCTION public.clamp_mcp_token_rotated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rotated_at IS NOT NULL AND NEW.rotated_at > now() THEN
    NEW.rotated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mcp_tokens_clamp_rotated_at ON public.mcp_tokens;
CREATE TRIGGER mcp_tokens_clamp_rotated_at
  BEFORE INSERT OR UPDATE ON public.mcp_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.clamp_mcp_token_rotated_at();

-- 2. Revoking a grant by either expression of its secret, in one statement.
--
-- A logout presents whatever secret the client happens to hold, which since the
-- overlap may be the current one OR the one a rotation just replaced. Done as
-- two DELETEs, a rotation landing between them escapes both: the first misses
-- because the presented value is already `previous_refresh_token`, the rotation
-- then advances a generation, and the second misses because the row's
-- `previous_refresh_token` has moved on. Both statements individually looked at
-- a row that held the secret, and neither deleted it.
--
-- One statement closes that. It also gives the revocation a linearization point:
-- against a concurrent rotation the grant is either deleted, or the rotation
-- committed first and the presented secret is genuinely no longer on the row.
--
-- What it does NOT do is recognize arbitrarily old secrets. The row keeps one
-- generation, so a value two rotations back is not on it under any column and
-- cannot be matched. That is the design's stated limit, and the reason this
-- returns a count: a caller that revoked nothing must be able to tell, instead
-- of reporting a revocation that did not happen.
--
-- A function rather than a PostgREST `or=(...)` filter because the secret comes
-- from a request body. `or` is a parsed expression and interpolating caller text
-- into one is an injection surface; a function argument is a parameter and
-- cannot be read as syntax.
CREATE OR REPLACE FUNCTION public.revoke_refresh_grant(
  p_secret text,
  p_client_ids text[]
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.mcp_tokens
   WHERE client_id = ANY(p_client_ids)
     AND (refresh_token = p_secret OR previous_refresh_token = p_secret);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- The API server calls this as `service_role`. Nothing else should be able to:
-- the argument is the only thing standing between a caller and a deleted grant.
REVOKE ALL ON FUNCTION public.revoke_refresh_grant(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_refresh_grant(text, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_refresh_grant(text, text[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_refresh_grant(text, text[]) TO service_role;
