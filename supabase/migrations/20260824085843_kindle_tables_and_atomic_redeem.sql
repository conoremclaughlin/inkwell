-- Kindle: restore the tables and make redemption + completion atomic.
--
-- The kindle feature's DDL is absent from the schema — kindle_tokens and
-- kindle_lineage exist in NO migration (the original 010/018 files were lost
-- in the baseline squash, PR #22), so create_kindle_token and
-- redeemKindleToken have been dead wiring against a missing table.
--
-- Restored FAITHFULLY from the original 010_kindle_lineage.sql (recovered
-- from git history, commit 16a8ab07) + 018_tighten_kindle_rls.sql: original
-- defaults (token self-generates server-side; expires_at now()+7d), CHECK
-- constraints, UNIQUE(child_user_id, child_agent_id), original indexes, and
-- the 018 service-role-only policies. Additions over the original:
--   - updated_at + the canonical trigger (migration hygiene rules)
--   - kindle_lineage.child_sb_id — the identity UUID binding (AGENTS.md:
--     programmatic refs use agent_identities.id, never the slug)
--   - the two atomic functions below
--
-- UPGRADE PATH (Lumen #528 r3 P1-2): a DB that still carries the original
-- 010/018 shape upgrades in place — CREATE TABLE IF NOT EXISTS keeps the old
-- tables, ALTERs add only what is missing, defaults are re-asserted
-- idempotently, and policies/triggers are drop-then-create by every name
-- they have ever had.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tables (original shape + additions) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.kindle_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent SB (optional — null for first-generation / self-serve)
  parent_agent_id text,
  parent_user_id uuid REFERENCES public.users(id),

  -- Facilitator (human who initiated the kindle)
  facilitator_user_id uuid NOT NULL REFERENCES public.users(id),

  -- New SB being kindled
  child_agent_id text NOT NULL,
  child_user_id uuid NOT NULL REFERENCES public.users(id),

  kindle_method text NOT NULL DEFAULT 'referral'
    CHECK (kindle_method IN ('referral', 'self_serve', 'organic')),

  value_seed jsonb DEFAULT '{}'::jsonb,

  onboarding_status text NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN (
      'pending', 'values_interview', 'naming',
      'soul_creation', 'complete', 'abandoned'
    )),
  onboarding_session_id uuid,
  interview_responses jsonb DEFAULT '[]'::jsonb,
  chosen_name text,

  created_at timestamptz DEFAULT now(),
  completed_at timestamptz,

  UNIQUE (child_user_id, child_agent_id)
);

CREATE TABLE IF NOT EXISTS public.kindle_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),

  creator_user_id uuid NOT NULL REFERENCES public.users(id),
  creator_agent_id text,

  value_seed jsonb DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  used_by_user_id uuid REFERENCES public.users(id),
  used_at timestamptz,
  expires_at timestamptz DEFAULT (now() + INTERVAL '7 days'),

  created_at timestamptz DEFAULT now()
);

-- Additions over the original shape — also the upgrade path for a DB that
-- still has the 010 tables.
ALTER TABLE public.kindle_lineage ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.kindle_lineage ADD COLUMN IF NOT EXISTS child_sb_id uuid REFERENCES public.agent_identities(id) ON DELETE SET NULL;
ALTER TABLE public.kindle_tokens ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Idempotent default re-assertion (a legacy table keeps its data; a table
-- created above is a no-op).
ALTER TABLE public.kindle_tokens ALTER COLUMN token SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE public.kindle_tokens ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '7 days');

-- Original indexes, original names.
CREATE INDEX IF NOT EXISTS idx_kindle_lineage_child ON public.kindle_lineage (child_user_id, child_agent_id);
CREATE INDEX IF NOT EXISTS idx_kindle_lineage_parent ON public.kindle_lineage (parent_user_id, parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_kindle_lineage_facilitator ON public.kindle_lineage (facilitator_user_id);
CREATE INDEX IF NOT EXISTS idx_kindle_lineage_status ON public.kindle_lineage (onboarding_status);
CREATE INDEX IF NOT EXISTS idx_kindle_tokens_token ON public.kindle_tokens (token);
CREATE INDEX IF NOT EXISTS idx_kindle_tokens_creator ON public.kindle_tokens (creator_user_id);
CREATE INDEX IF NOT EXISTS idx_kindle_tokens_status ON public.kindle_tokens (status);

-- Canonical updated_at triggers (drop-then-create: safe on both fresh and
-- legacy shapes).
DROP TRIGGER IF EXISTS kindle_tokens_updated_at ON public.kindle_tokens;
CREATE TRIGGER kindle_tokens_updated_at
  BEFORE UPDATE ON public.kindle_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS kindle_lineage_updated_at ON public.kindle_lineage;
CREATE TRIGGER kindle_lineage_updated_at
  BEFORE UPDATE ON public.kindle_lineage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: 018-style service-role-only. Drop by EVERY name these policies have
-- ever had (010's wide-open names, 018's names, and this migration's r2
-- names) so re-creation never aborts on a legacy DB.
ALTER TABLE public.kindle_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kindle_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_kindle_lineage" ON public.kindle_lineage;
DROP POLICY IF EXISTS "service_role_kindle_tokens" ON public.kindle_tokens;
DROP POLICY IF EXISTS "Service role full access to kindle_lineage" ON public.kindle_lineage;
DROP POLICY IF EXISTS "Service role full access to kindle_tokens" ON public.kindle_tokens;
CREATE POLICY "Service role full access to kindle_lineage"
  ON public.kindle_lineage FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);
CREATE POLICY "Service role full access to kindle_tokens"
  ON public.kindle_tokens FOR ALL
  USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

-- ── Atomic redemption ───────────────────────────────────────────────────
--
-- Token consumption + lineage + identity creation in ONE transaction (Lumen
-- #528 r2 P1): the conditional token UPDATE is the concurrency guard (two
-- concurrent redeems — exactly one wins), and any later failure (identity
-- collision, FK violation) rolls the whole redemption back, so a failed
-- redeem never burns the one-time token or strands a lineage row.

DROP FUNCTION IF EXISTS public.redeem_kindle_token(text, uuid, uuid, jsonb);
CREATE FUNCTION public.redeem_kindle_token(
  p_token text,
  p_new_user_id uuid,
  p_workspace_id uuid,
  p_identity jsonb
) RETURNS public.kindle_lineage AS $$
DECLARE
  v_token public.kindle_tokens%ROWTYPE;
  v_lineage public.kindle_lineage%ROWTYPE;
  v_temp_agent_id text;
  v_sb_id uuid;
BEGIN
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

  -- Workspace-scoped identity, full-key conflict target: a collision or FK
  -- violation aborts the WHOLE redemption (token restored by rollback).
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

-- ── Atomic completion ───────────────────────────────────────────────────
--
-- Rename + lineage completion in ONE transaction (Lumen #528 r3 P1-4): a
-- lineage-write failure rolls back the rename, so a half-completed
-- onboarding (renamed identity, active temp lineage, permanently failing
-- retry) cannot exist. User-scoped INSIDE the function (r3 P1-3): only the
-- kindled user completes their own onboarding.

DROP FUNCTION IF EXISTS public.complete_kindle_onboarding(uuid, uuid, text, text, text);
CREATE FUNCTION public.complete_kindle_onboarding(
  p_kindle_id uuid,
  p_user_id uuid,
  p_chosen_name text,
  p_final_agent_id text,
  p_soul text
) RETURNS public.kindle_lineage AS $$
DECLARE
  v_lineage public.kindle_lineage%ROWTYPE;
  v_renamed uuid;
BEGIN
  SELECT * INTO v_lineage
  FROM public.kindle_lineage
  WHERE id = p_kindle_id AND child_user_id = p_user_id
  FOR UPDATE;
  IF v_lineage.id IS NULL THEN
    RAISE EXCEPTION 'kindle lineage % not found for this user', p_kindle_id;
  END IF;
  IF v_lineage.onboarding_status = 'complete' THEN
    RAISE EXCEPTION 'kindle onboarding % is already complete', p_kindle_id;
  END IF;

  -- Rename by identity UUID when the binding exists (post-redeem rows);
  -- legacy rows fall back to the slug, still user-scoped.
  IF v_lineage.child_sb_id IS NOT NULL THEN
    UPDATE public.agent_identities
    SET agent_id = p_final_agent_id,
        name = p_chosen_name,
        role = 'Personal SB',
        description = 'Kindled from ' || COALESCE(v_lineage.value_seed->>'parentName', 'first principles'),
        soul = COALESCE(p_soul, soul),
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('kindleId', p_kindle_id, 'onboarding', false)
    WHERE id = v_lineage.child_sb_id AND user_id = p_user_id
    RETURNING id INTO v_renamed;
  ELSE
    UPDATE public.agent_identities
    SET agent_id = p_final_agent_id,
        name = p_chosen_name,
        role = 'Personal SB',
        description = 'Kindled from ' || COALESCE(v_lineage.value_seed->>'parentName', 'first principles'),
        soul = COALESCE(p_soul, soul),
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('kindleId', p_kindle_id, 'onboarding', false)
    WHERE user_id = p_user_id AND agent_id = v_lineage.child_agent_id
    RETURNING id INTO v_renamed;
  END IF;

  IF v_renamed IS NULL THEN
    RAISE EXCEPTION 'kindle onboarding identity not found for lineage %', p_kindle_id;
  END IF;

  UPDATE public.kindle_lineage
  SET child_agent_id = p_final_agent_id,
      chosen_name = p_chosen_name,
      onboarding_status = 'complete',
      completed_at = now()
  WHERE id = p_kindle_id
  RETURNING * INTO v_lineage;

  RETURN v_lineage;
END;
$$ LANGUAGE plpgsql;

-- Service-role only (Lumen #528 r3 P2): these functions mutate identities
-- and consume invites — no anon/authenticated execution.
REVOKE ALL ON FUNCTION public.redeem_kindle_token(text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_kindle_onboarding(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
