-- Browser companion grants: the authority behind a `browser_client` token.
--
-- WHY THIS IS NOT A ROW IN mcp_tokens, which is where it obviously belongs:
--
-- `POST /token` (mcp/server.ts) reads `refresh_token` AND `client_id` from the
-- request body and hands both to exchangeRefreshTokenShared(..., 'mcp_access',
-- ACCESS_TOKEN_LIFETIME_SECONDS). The only binding to the stored row is
--   if (tokenRecord.client_id !== clientId) return null;   -- ink-tokens.ts
-- which compares the row's client_id to the one the caller just supplied.
-- There is no allowlist of legal client_ids on that path, and the minted
-- token's `type` is fixed by the endpoint rather than read from the row.
--
-- So every row in mcp_tokens is exchangeable for a full 30-day mcp_access JWT
-- by anyone holding its refresh_token value and knowing its client_id string.
-- A browser grant stored there as client_id='browser-companion' would have
-- been convertible into the general MCP credential in one request, defeating
-- the companion route allowlist entirely. Tracked separately as an Inkwell
-- task against the mobile-pair rows that live there today.
--
-- Nothing the extension holds is ever written to mcp_tokens.

BEGIN;

CREATE TABLE IF NOT EXISTS public.browser_companion_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Identifies the extension installation. Opaque to the server: it is
  -- compared to the token's claim, never parsed. It is an identifier, NOT a
  -- secret — the extension shows it to the dashboard, so anything that treats
  -- knowing it as proof of being it is not a binding.
  installation_id text NOT NULL,

  -- sha256 hex of a secret the installation generated LOCALLY and has never
  -- sent anywhere. Supplied at issuance as a commitment; the preimage is
  -- presented once, at claim, and matched against this column in the claim's
  -- own UPDATE predicate.
  --
  -- Without it, a pairing code plus an installation_id is claimable by any
  -- installation that observes both — and neither is secret. The code is read
  -- off a screen and the installation id is handed to the dashboard to mint
  -- against. The commitment is what makes the claiming installation the same
  -- one that started the pairing.
  installation_commitment text NOT NULL,

  -- sha256 hex of the secrets. The plaintext of either is returned exactly
  -- once, at the moment it is minted, and is never stored or logged.
  --
  -- pairing_code_hash is the short human-transcribed code and is cleared on
  -- claim, which is what makes the code single-use. pairing_secret_hash is
  -- what the extension keeps in storage.session and presents to mint a
  -- browser_client JWT.
  pairing_code_hash text,
  pairing_code_expires_at timestamptz,
  pairing_secret_hash text,

  claimed_at timestamptz,

  -- Wall-clock ceiling and revocation. A grant is dead when it is past
  -- expires_at OR revoked, and each refusal carries its own reason code so the
  -- extension can tell them apart.
  --
  -- There is deliberately NO action counter here. This grant is pairing and
  -- installation authority — it says a credential may exist, not that a page
  -- may be read or written. Page-session budgets are a separate, separately
  -- human-authorized object with its own short ceiling and its own counter,
  -- spent atomically by a real admitted action. A counter on this row would
  -- have been decremented by the extension's own `/session` polling, so it
  -- would have measured elapsed time and called it actions.
  --
  -- Both conditions are evaluated lazily, on every companion request, in the
  -- same query that loads the grant. There is deliberately NO sweep:
  -- sweepExpiredLeases() runs inside `if (heartbeatServiceEnabled)`, and
  -- CLAUDE.md requires ENABLE_HEARTBEATS=false on every isolated test server
  -- (worktree-started servers auto-disable). Expiry riding that sweep would
  -- mean nothing ever expires in the exact environment where this extension
  -- gets developed and acceptance-tested, and the expiry tests would pass
  -- green on the broken path for environmental reasons.
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,

  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The claim path looks a grant up by code hash alone, so this must be unique
-- and fast. Partial, because the column is NULLed on claim and many claimed
-- grants would otherwise collide on NULL under a plain unique index.
CREATE UNIQUE INDEX IF NOT EXISTS browser_companion_grants_pairing_code_hash_key
  ON public.browser_companion_grants (pairing_code_hash)
  WHERE pairing_code_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS browser_companion_grants_pairing_secret_hash_key
  ON public.browser_companion_grants (pairing_secret_hash)
  WHERE pairing_secret_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS browser_companion_grants_user_live_idx
  ON public.browser_companion_grants (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TRIGGER browser_companion_grants_updated_at
  BEFORE UPDATE ON public.browser_companion_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Grant lifecycle, recorded as FIELDS.
--
-- `reason_code` is a machine token ('grant_revoked', 'grant_expired',
-- 'grant_action_cap', 'installation_mismatch', …), never a sentence. A
-- studio_lease_events row has already asserted a cause nobody measured — it
-- read "tier studio-hint resolved a studio held by X" when the hint had
-- resolved to undefined, because the sentence was stitched from independent
-- fields that were each individually correct. Prose is rendered from these
-- columns at read time, never stored.
CREATE TABLE IF NOT EXISTS public.browser_companion_grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES public.browser_companion_grants(id) ON DELETE CASCADE,
  event text NOT NULL,
  reason_code text,
  at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT browser_companion_grant_events_event_check CHECK (
    event IN ('created', 'claimed', 'token_issued', 'refused', 'revoked')
  )
);

CREATE INDEX IF NOT EXISTS browser_companion_grant_events_grant_idx
  ON public.browser_companion_grant_events (grant_id, at DESC);

-- RLS: enabled with no policy, so the `anon`/`authenticated` roles reach
-- nothing here at all. The API server connects as service_role
-- (rolbypassrls = true) and is the only reader; per CLAUDE.md the real
-- boundary is the server's auth middleware, and the frontend never queries
-- this table directly. A permissive `USING (true)` service policy would be
-- the pattern to copy from older tables, but there is no client-side path
-- that needs one — and this table holds credential material.
ALTER TABLE public.browser_companion_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.browser_companion_grant_events ENABLE ROW LEVEL SECURITY;

-- The whole grant check, in one statement.
--
-- Every companion request calls this. It is plpgsql rather than a sequence of
-- supabase-js calls because it is the single place enforcement lives: a future
-- caller that loads the grant row itself and forgets one of the refusal
-- conditions cannot happen if there is nothing to forget. One entry point,
-- one set of reason codes, allowed or refused.
--
-- Claims are cross-checked here, not trusted: the JWT's grant/user/workspace/
-- installation are compared to the stored row, and a disagreement is a refusal
-- with its own reason code rather than a fall-through.
--
-- p_require_live = false is the revocation exemption and ONLY that.
--
-- Revoking has to stay possible after the thing being revoked has expired,
-- which is precisely when a user is most likely to want it gone. Routing
-- /auth/revoke through the same liveness gate it exists to close would mean an
-- expired grant could never be withdrawn — its row would sit there, claimed
-- and unrevoked, until someone went into the database.
--
-- So the exemption drops exactly two conditions (revoked_at, expires_at) and
-- keeps every identity condition: the caller must still prove the grant is
-- theirs, from the installation it was bound to. It grants nothing readable —
-- the only route that passes false is the one whose handler writes revoked_at
-- and returns an acknowledgement.
CREATE OR REPLACE FUNCTION public.browser_companion_consume_grant(
  p_grant_id uuid,
  p_user_id uuid,
  p_workspace_id uuid,
  p_installation_id text,
  p_require_live boolean DEFAULT true
)
RETURNS TABLE (
  outcome text,
  reason_code text,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant public.browser_companion_grants%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_grant
  FROM public.browser_companion_grants
  WHERE id = p_grant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No event row: the FK has nothing to point at.
    RETURN QUERY SELECT 'refused'::text, 'grant_not_found'::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  -- Identity first, and unconditionally. These hold on the revocation path
  -- too: the exemption is about liveness, never about ownership.
  IF v_grant.claimed_at IS NULL THEN
    v_reason := 'grant_unclaimed';
  ELSIF v_grant.user_id <> p_user_id THEN
    v_reason := 'user_mismatch';
  ELSIF v_grant.workspace_id <> p_workspace_id THEN
    v_reason := 'workspace_mismatch';
  ELSIF v_grant.installation_id <> p_installation_id THEN
    v_reason := 'installation_mismatch';
  ELSIF p_require_live AND v_grant.revoked_at IS NOT NULL THEN
    v_reason := 'grant_revoked';
  ELSIF p_require_live AND v_grant.expires_at <= now() THEN
    v_reason := 'grant_expired';
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.browser_companion_grant_events (grant_id, event, reason_code)
    VALUES (v_grant.id, 'refused', v_reason);

    RETURN QUERY SELECT 'refused'::text, v_reason, v_grant.expires_at, v_grant.revoked_at;
    RETURN;
  END IF;

  UPDATE public.browser_companion_grants
  SET last_used_at = now()
  WHERE id = v_grant.id;

  RETURN QUERY SELECT 'allowed'::text, NULL::text, v_grant.expires_at, v_grant.revoked_at;
END;
$$;

COMMIT;
