-- Inkling: self-serve awakening, and replay-safe human messages.
--
-- Three changes, all additive for existing callers:
--
-- 1. redeem_kindle_token gains an optional p_kindle_method (default
--    'referral', so every existing call means what it meant; an explicit
--    NULL means 'referral' too, rather than failing). With
--    'self_serve', the awakening is complete the moment it is created: the
--    lineage is written 'complete' with completed_at, and the identity's
--    onboarding flag is false. There is no open state to get stuck in, and
--    naming stays optional forever. A self-serve awakening has no parent, so
--    the lineage's parent columns stay null (the table's own comment says
--    so), and it redeems only the person's own parentless token: an invite
--    minted by someone else is a referral and keeps its onboarding.
--    Adding a parameter changes the signature, so the old one is dropped
--    first: with both present, a call naming only the original four
--    parameters would be ambiguous. Server code without the new parameter
--    keeps working against this function; server code that passes it needs
--    this migration applied first (PROCESS: "When a function is
--    unavoidable").
--
-- 2. One identity per awakening request: a client sends the same
--    awakenRequestId on every retry of one awakening, and this index makes
--    a second identity for it impossible, even when two retries race. The
--    loser's redemption rolls back as a whole.
--
-- 3. One message per client message id per thread: a person's retried send
--    carries the same clientMessageId, and this index makes a second copy
--    impossible, even when two retries race. The thread key is the client's
--    (POST /api/admin/threads takes it from the request), so a retried
--    create lands on the same thread and is caught here too.
--
-- Both indexes are partial on `(metadata->>'key') IS NOT NULL`, which the
-- code's `metadata->>'key' = $1` lookups imply, so the planner can use them
-- for those lookups (`metadata ? 'key'` cannot be proved from the equality).
-- Neither metadata key exists in any row today (read on 2026-10-01), so both
-- indexes build without conflict.

DROP FUNCTION IF EXISTS public.redeem_kindle_token(text, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.redeem_kindle_token(text, uuid, uuid, jsonb, text);
CREATE FUNCTION public.redeem_kindle_token(
  p_token text,
  p_new_user_id uuid,
  p_workspace_id uuid,
  p_identity jsonb,
  p_kindle_method text DEFAULT 'referral'
) RETURNS public.kindle_lineage AS $$
DECLARE
  v_token public.kindle_tokens%ROWTYPE;
  v_lineage public.kindle_lineage%ROWTYPE;
  v_temp_agent_id text;
  v_sb_id uuid;
  v_method text := COALESCE(p_kindle_method, 'referral');
  v_self_serve boolean;
BEGIN
  IF v_method NOT IN ('referral', 'self_serve') THEN
    RAISE EXCEPTION 'unsupported kindle method %', v_method;
  END IF;
  v_self_serve := v_method = 'self_serve';

  UPDATE public.kindle_tokens
  SET status = 'used', used_by_user_id = p_new_user_id, used_at = now()
  WHERE token = p_token
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING * INTO v_token;
  IF v_token.id IS NULL THEN
    RAISE EXCEPTION 'kindle token is not redeemable (unknown, already used, or expired)';
  END IF;

  -- A self-serve awakening redeems the person's own parentless token. The
  -- exception rolls the token update above back with everything else.
  IF v_self_serve
     AND (v_token.creator_agent_id IS NOT NULL OR v_token.creator_user_id <> p_new_user_id) THEN
    RAISE EXCEPTION 'a self-serve awakening redeems only the person''s own parentless token';
  END IF;

  v_temp_agent_id := 'kindle-' || v_token.id;

  INSERT INTO public.kindle_lineage (
    parent_agent_id, parent_user_id, facilitator_user_id,
    child_agent_id, child_user_id, kindle_method, value_seed, onboarding_status,
    completed_at
  ) VALUES (
    v_token.creator_agent_id,
    CASE WHEN v_self_serve THEN NULL ELSE v_token.creator_user_id END,
    v_token.creator_user_id,
    v_temp_agent_id, p_new_user_id, v_method, v_token.value_seed,
    CASE WHEN v_self_serve THEN 'complete' ELSE 'values_interview' END,
    CASE WHEN v_self_serve THEN now() ELSE NULL END
  ) RETURNING * INTO v_lineage;

  -- Workspace-scoped identity, full-key conflict target: a collision or FK
  -- violation aborts the WHOLE redemption (token restored by rollback). So
  -- does a second identity for the same awakenRequestId (the index below):
  -- that conflict is on a different index, which ON CONFLICT does not cover.
  INSERT INTO public.agent_identities (
    user_id, workspace_id, agent_id, name, role, description, soul, values, metadata
  ) VALUES (
    p_new_user_id,
    p_workspace_id,
    v_temp_agent_id,
    COALESCE(p_identity->>'name', 'New SB'),
    COALESCE(p_identity->>'role', 'Nascent SB in onboarding'),
    p_identity->>'description',
    p_identity->>'soul',
    COALESCE(p_identity->'values', '[]'::jsonb),
    COALESCE(p_identity->'metadata', '{}'::jsonb)
      || jsonb_build_object('kindleId', v_lineage.id, 'onboarding', NOT v_self_serve)
  )
  ON CONFLICT (user_id, workspace_id, agent_id) DO UPDATE SET
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    description = EXCLUDED.description,
    soul = EXCLUDED.soul,
    values = EXCLUDED.values,
    metadata = EXCLUDED.metadata
  RETURNING id INTO v_sb_id;

  -- The identity UUID binding (AGENTS.md): programmatic refs use
  -- agent_identities.id — completion renames by THIS id, never the slug.
  UPDATE public.kindle_lineage
  SET child_sb_id = v_sb_id
  WHERE id = v_lineage.id
  RETURNING * INTO v_lineage;

  RETURN v_lineage;
END;
$$ LANGUAGE plpgsql;

-- Service-role only, as before (Lumen #528 r3 P2), and granted back
-- explicitly rather than through default privileges (#528 r4 P2-1): the DROP
-- above took the old grant with it.
REVOKE ALL ON FUNCTION public.redeem_kindle_token(text, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_kindle_token(text, uuid, uuid, jsonb, text) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS agent_identities_user_awaken_request_key
  ON public.agent_identities (user_id, (metadata->>'awakenRequestId'))
  WHERE (metadata->>'awakenRequestId') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inbox_thread_messages_thread_client_message_key
  ON public.inbox_thread_messages (thread_id, (metadata->>'clientMessageId'))
  WHERE (metadata->>'clientMessageId') IS NOT NULL;
