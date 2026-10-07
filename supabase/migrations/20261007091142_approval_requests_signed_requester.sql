-- Approvals step A: record who asked, from a signed source
-- (ink://designs/inkling-approvals-extension §A).
--
-- approval_requests named its requester only by `requesting_agent_id`, a slug
-- read from the unsigned x-ink-context header, so no list could be scoped to
-- one canonical inkling. A runner's access token carries its identity's
-- canonical id, signed. The create route now records that id, and the
-- identity's own workspace, when it names an identity of the same user.
--
-- Both columns are nullable and stay null for rows created before this, and
-- for requests made without an agent token. A scoped read shows only rows
-- with a signed requester. `requesting_agent_id` is unchanged: the approval
-- interceptor still scopes by it.

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS sb_id uuid REFERENCES public.agent_identities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS approval_requests_user_sb_created_idx
  ON public.approval_requests (user_id, sb_id, created_at DESC, id DESC);
