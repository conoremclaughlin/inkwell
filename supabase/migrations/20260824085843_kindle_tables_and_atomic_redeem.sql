-- Kindle: restore the tables and make redemption atomic.
--
-- The kindle feature's DDL is absent from the schema — kindle_tokens and
-- kindle_lineage exist nowhere in migrations (lost in the baseline squash,
-- PR #22), so create_kindle_token and redeemKindleToken have been dead
-- wiring against a missing table. Recreated here from the service's full
-- column surface.
--
-- redeem_kindle_token puts token consumption + lineage creation + identity
-- creation behind ONE transaction (Lumen #528 r2 P1): the conditional
-- token UPDATE is the concurrency guard (two concurrent redeems — exactly
-- one wins), and any later failure (identity collision, FK violation)
-- rolls back the whole redemption, so a failed redeem never burns the
-- one-time token or strands a lineage row.

CREATE TABLE IF NOT EXISTS public.kindle_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  creator_user_id uuid NOT NULL REFERENCES public.users(id),
  creator_agent_id text,
  value_seed jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  used_by_user_id uuid REFERENCES public.users(id),
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kindle_tokens_status_idx ON public.kindle_tokens (status);

CREATE TABLE IF NOT EXISTS public.kindle_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_id text,
  parent_user_id uuid REFERENCES public.users(id),
  facilitator_user_id uuid REFERENCES public.users(id),
  child_agent_id text NOT NULL,
  child_user_id uuid NOT NULL REFERENCES public.users(id),
  kindle_method text NOT NULL DEFAULT 'referral',
  value_seed jsonb NOT NULL DEFAULT '{}'::jsonb,
  onboarding_status text NOT NULL DEFAULT 'values_interview',
  onboarding_session_id uuid,
  interview_responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kindle_lineage_child_idx
  ON public.kindle_lineage (child_user_id, onboarding_status);

CREATE TRIGGER kindle_tokens_updated_at
  BEFORE UPDATE ON public.kindle_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER kindle_lineage_updated_at
  BEFORE UPDATE ON public.kindle_lineage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.kindle_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kindle_lineage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access to kindle_tokens" ON public.kindle_tokens
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);
CREATE POLICY "Service role full access to kindle_lineage" ON public.kindle_lineage
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE OR REPLACE FUNCTION public.redeem_kindle_token(
  p_token text,
  p_new_user_id uuid,
  p_workspace_id uuid,
  p_identity jsonb
) RETURNS public.kindle_lineage AS $$
DECLARE
  v_token public.kindle_tokens%ROWTYPE;
  v_lineage public.kindle_lineage%ROWTYPE;
  v_temp_agent_id text;
BEGIN
  -- Conditional consumption IS the concurrency guard: of two concurrent
  -- redeems, exactly one matches status='active'.
  UPDATE public.kindle_tokens
  SET status = 'used', used_by_user_id = p_new_user_id, used_at = now()
  WHERE token = p_token
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING * INTO v_token;
  IF v_token.id IS NULL THEN
    RAISE EXCEPTION 'kindle token is not redeemable (unknown, already used, or expired)';
  END IF;

  v_temp_agent_id := 'kindle-' || v_token.id;

  INSERT INTO public.kindle_lineage (
    parent_agent_id, parent_user_id, facilitator_user_id,
    child_agent_id, child_user_id, kindle_method, value_seed, onboarding_status
  ) VALUES (
    v_token.creator_agent_id, v_token.creator_user_id, v_token.creator_user_id,
    v_temp_agent_id, p_new_user_id, 'referral', v_token.value_seed, 'values_interview'
  ) RETURNING * INTO v_lineage;

  -- Workspace-scoped identity, full-key conflict target: a rename collision
  -- or FK violation aborts the WHOLE redemption (token restored by rollback).
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
      || jsonb_build_object('kindleId', v_lineage.id, 'onboarding', true)
  )
  ON CONFLICT (user_id, workspace_id, agent_id) DO UPDATE SET
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    description = EXCLUDED.description,
    soul = EXCLUDED.soul,
    values = EXCLUDED.values,
    metadata = EXCLUDED.metadata;

  RETURN v_lineage;
END;
$$ LANGUAGE plpgsql;
