-- session_observe_grants — explicit observer×owner permission for live
-- session observation (spec:observer-attach §4.6, observer-attach M3).
--
-- The existing set_permission machinery is a per-user capability override and
-- cannot express observer-identity × owner-identity policy. This table is the
-- dedicated grant store: a row means "observer identity may attach (read-only)
-- to sessions owned by owner identity, for this user". Default deny — no row,
-- no observation. Identity UUIDs only, never agent slugs (CLAUDE.md rule).
--
-- Contact isolation (v1): sessions carrying a contact_id are NEVER observable
-- under these grants — enforced in the API layer, noted here for the record.

CREATE TABLE public.session_observe_grants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  observer_sb_id uuid NOT NULL REFERENCES public.agent_identities (id) ON DELETE CASCADE,
  owner_sb_id uuid NOT NULL REFERENCES public.agent_identities (id) ON DELETE CASCADE,
  granted_by text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_observe_grants_unique UNIQUE (user_id, observer_sb_id, owner_sb_id),
  CONSTRAINT session_observe_grants_no_self CHECK (observer_sb_id <> owner_sb_id)
);

CREATE INDEX idx_session_observe_grants_lookup
  ON public.session_observe_grants (user_id, observer_sb_id, owner_sb_id);

ALTER TABLE public.session_observe_grants ENABLE ROW LEVEL SECURITY;

-- Service-role safety net, consistent with sibling tables: application-level
-- auth (JWT-verified identity + this table) is the real boundary.
CREATE POLICY session_observe_grants_service ON public.session_observe_grants
  FOR ALL USING (true) WITH CHECK (true);
