-- Joining a group by invitation (ink://designs/inkling-workspace-invitations).
--
-- One invitation table serves both kinds:
--   - code:  a shareable group code. Anyone signed in who has it can join,
--            until it expires, is revoked, or reaches max_uses (null means
--            unlimited).
--   - email: addressed to one email address. Only an account signed in with
--            that address can use it, once.
-- Either way the secret itself is never stored: token_digest is its SHA-256.
-- Invitations last 30 days unless created with a shorter expiry.
--
-- Joining is one database function, accept_workspace_invitation. It checks
-- the invitation, the group and the inviter's current authority under row
-- locks, adds the person as a member (keeping any role they already have),
-- records the redemption and counts the use, all in one transaction. Expiry is
-- judged again after the last write that could have waited, so a wait never
-- carries a join past it. Nothing else here is a function: creating,
-- listing and revoking invitations are ordinary queries. No trigger and no
-- policy: row level security is on with no policies, so only the service role
-- the API uses can read or write these tables.
--
-- THIS RELEASE CARRIES A DATABASE FUNCTION CHANGE. Apply this migration before
-- restarting the server on the code that calls it.

CREATE TABLE IF NOT EXISTS public.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  invitee_email text,
  token_digest text NOT NULL,
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  max_uses integer,
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  CONSTRAINT workspace_invitations_kind_check CHECK (kind IN ('code', 'email')),
  -- An email invitation names its address and is used once; a code names none.
  CONSTRAINT workspace_invitations_email_shape CHECK (
    (kind = 'email' AND invitee_email IS NOT NULL AND max_uses = 1)
    OR (kind = 'code' AND invitee_email IS NULL)
  ),
  CONSTRAINT workspace_invitations_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT workspace_invitations_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT workspace_invitations_use_count_check CHECK (
    use_count >= 0 AND (max_uses IS NULL OR use_count <= max_uses)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_token_digest_key
  ON public.workspace_invitations (token_digest);
CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_idx
  ON public.workspace_invitations (workspace_id, created_at DESC);

-- One row per account per invitation it was used for. membership_id is the
-- membership that use created (null if the person was already a member). A
-- retry of an accepted invitation finds its row here and changes nothing.
CREATE TABLE IF NOT EXISTS public.workspace_invitation_redemptions (
  invitation_id uuid NOT NULL REFERENCES public.workspace_invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  membership_id uuid,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, user_id)
);

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitation_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_invitations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_invitation_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_invitations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_invitation_redemptions TO service_role;

-- ── Accepting an invitation ─────────────────────────────────────────────
--
-- p_token_digest is the SHA-256 of the code the person entered; the API
-- authenticates the account and passes its id and email.
-- p_email_ownership_confirmed is the operator's statement that sign-up on
-- this server confirms email addresses (INVITE_EMAIL_OWNERSHIP_CONFIRMED);
-- without it, an email match proves nothing, so email invitations are
-- refused. The workspace, role and inviter come only from the invitation
-- row. Every refusal answers the same {"status":"unavailable"}, so a caller
-- learns nothing about why.
--
-- Lock order: the invitation, then its workspace, then the inviter's
-- membership. A concurrent revoke of the same invitation waits, or is waited
-- for; two people using the last use of a code are serialised on its row.

DROP FUNCTION IF EXISTS public.accept_workspace_invitation(text, uuid, text, boolean);
CREATE FUNCTION public.accept_workspace_invitation(
  p_token_digest text,
  p_user_id uuid,
  p_user_email text,
  p_email_ownership_confirmed boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_invitation public.workspace_invitations%ROWTYPE;
  v_workspace public.workspaces%ROWTYPE;
  v_inviter_role text;
  v_member_id uuid;
  v_existing_member_id uuid;
  v_unavailable constant jsonb := jsonb_build_object('status', 'unavailable');
BEGIN
  SELECT * INTO v_invitation
  FROM public.workspace_invitations
  WHERE token_digest = p_token_digest
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN v_unavailable;
  END IF;

  SELECT * INTO v_workspace
  FROM public.workspaces
  WHERE id = v_invitation.workspace_id
  FOR SHARE;

  SELECT id INTO v_existing_member_id
  FROM public.workspace_members
  WHERE workspace_id = v_invitation.workspace_id AND user_id = p_user_id;

  -- A retry of an invitation this account already used: answer from the
  -- membership as it is now. Never recreate one that has since gone.
  IF EXISTS (
    SELECT 1 FROM public.workspace_invitation_redemptions
    WHERE invitation_id = v_invitation.id AND user_id = p_user_id
  ) THEN
    IF v_existing_member_id IS NULL THEN
      RETURN v_unavailable;
    END IF;
    RETURN jsonb_build_object(
      'status', 'joined',
      'workspaceId', v_invitation.workspace_id,
      'membershipId', v_existing_member_id,
      'alreadyMember', true
    );
  END IF;

  -- Already in the group: nothing to do, and no use of the invitation spent.
  IF v_existing_member_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'joined',
      'workspaceId', v_invitation.workspace_id,
      'membershipId', v_existing_member_id,
      'alreadyMember', true
    );
  END IF;

  -- The invitation itself. Its expiry is judged again after the grant, below.
  IF v_invitation.revoked_at IS NOT NULL
     OR v_invitation.expires_at <= clock_timestamp()
     OR (v_invitation.max_uses IS NOT NULL AND v_invitation.use_count >= v_invitation.max_uses) THEN
    RETURN v_unavailable;
  END IF;

  -- An email invitation is only for an account signed in with that address,
  -- and only where sign-up proved the account owns it.
  IF v_invitation.kind = 'email' AND (
    p_email_ownership_confirmed IS NOT TRUE
    OR lower(v_invitation.invitee_email) IS DISTINCT FROM lower(trim(p_user_email))
  ) THEN
    RETURN v_unavailable;
  END IF;

  -- Only an active group takes members this way; a personal space never does.
  IF v_workspace.id IS NULL OR v_workspace.type <> 'team' OR v_workspace.archived_at IS NOT NULL THEN
    RETURN v_unavailable;
  END IF;

  -- The person who made the invitation must still be able to invite.
  SELECT role INTO v_inviter_role
  FROM public.workspace_members
  WHERE workspace_id = v_invitation.workspace_id AND user_id = v_invitation.created_by
  FOR SHARE;
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner', 'admin') THEN
    RETURN v_unavailable;
  END IF;

  -- An account that has asked to be deleted joins nothing new.
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_requests
    WHERE user_id = p_user_id AND completed_at IS NULL
  ) THEN
    RETURN v_unavailable;
  END IF;

  -- The grant. Its insert can itself wait (on another request inserting the
  -- same membership), as could the locks above, so the expiry is judged once
  -- more after its last write. If it passed meanwhile, the error undoes this
  -- block's writes, and nothing is granted.
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (v_invitation.workspace_id, p_user_id, 'member')
    ON CONFLICT (workspace_id, user_id) DO NOTHING
    RETURNING id INTO v_member_id;

    IF v_member_id IS NULL THEN
      -- Joined a moment ago by another request: keep that membership and its role.
      SELECT id INTO v_existing_member_id
      FROM public.workspace_members
      WHERE workspace_id = v_invitation.workspace_id AND user_id = p_user_id;
      RETURN jsonb_build_object(
        'status', 'joined',
        'workspaceId', v_invitation.workspace_id,
        'membershipId', v_existing_member_id,
        'alreadyMember', true
      );
    END IF;

    INSERT INTO public.workspace_invitation_redemptions (invitation_id, user_id, membership_id)
    VALUES (v_invitation.id, p_user_id, v_member_id);

    UPDATE public.workspace_invitations
    SET use_count = use_count + 1
    WHERE id = v_invitation.id;

    IF v_invitation.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'invitation expired while joining' USING ERRCODE = 'WI001';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'WI001' THEN
      RETURN v_unavailable;
  END;

  RETURN jsonb_build_object(
    'status', 'joined',
    'workspaceId', v_invitation.workspace_id,
    'membershipId', v_member_id,
    'alreadyMember', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_workspace_invitation(text, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(text, uuid, text, boolean)
  TO service_role;
