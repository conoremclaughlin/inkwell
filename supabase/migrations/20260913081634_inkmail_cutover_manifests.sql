-- Inkmail thread scope — cutover manifests and preflight
-- Spec: ink://specs/inkmail-thread-scope §4, §4a (v9, approved 2026-09-12)
--
-- This file changes no live table. It installs:
--
--   1. Two staging tables the operator loads BEFORE the cutover transaction —
--      the attestation manifests of §4a. They are kept outside git as CSV
--      (they carry user UUIDs); this is where they land as transaction input.
--   2. Suggestion functions that draft those manifests from the candidate
--      classes of §4a.1–4a.2. A suggestion is a hint for the reviewer's
--      column. It attests nothing; the cutover never reads it.
--   3. The read-only preflight, `inkmail_cutover_preflight()`, which lists
--      every finding that would abort the cutover, with row ids. The operator
--      runs it standalone before the window; the cutover runs it first and
--      aborts on any finding.
--
-- The governing rule (§4a): slug lookups, sender stamps, notice shapes,
-- metadata labels, session stamps and namespace values are candidate hints.
-- A workspace or an author is WRITTEN only on an operator attestation loaded
-- here (no automatic provenance source is assumed to exist). Missing
-- evidence aborts; contradicted evidence aborts.
--
-- Everything installed here is dropped by the cutover migration.

-- ── 1. Manifests ───────────────────────────────────────────────────────────

-- thread → workspace (§4a.1). One row per thread; the cutover requires every
-- thread to be listed.
CREATE TABLE public.inkmail_cutover_thread_attestations (
  thread_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  attested_by text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- row/batch → principal (§4a.2). A row with row_id attests one message; a
-- row without attests every legacy row in (thread, scope, legacy_id). Row
-- wins over batch. `legacy_id` is the slug the legacy column holds
-- (sender_agent_id, participants.agent_id, read_status.agent_id,
-- created_by_agent_id, closed_by_agent_id). An SB may be named by id or by
-- slug; a slug is resolved in the thread's attested workspace and must match
-- exactly one identity there.
CREATE TABLE public.inkmail_cutover_principal_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('message', 'participant', 'read_status', 'creator', 'closer')),
  thread_id uuid NOT NULL,
  legacy_id text NOT NULL,
  row_id uuid,
  kind text NOT NULL CHECK (kind IN ('sb', 'user', 'system')),
  sb_id uuid,
  sb_agent_id text,
  user_id uuid,
  attested_by text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inkmail_cutover_principal_kind_ids CHECK (
    (kind = 'sb' AND (sb_id IS NOT NULL OR sb_agent_id IS NOT NULL) AND user_id IS NULL)
    OR (kind = 'user' AND user_id IS NOT NULL AND sb_id IS NULL AND sb_agent_id IS NULL)
    OR (kind = 'system' AND sb_id IS NULL AND sb_agent_id IS NULL AND user_id IS NULL)
  ),
  -- A participant or a read pointer is always somebody.
  CONSTRAINT inkmail_cutover_principal_no_system_participants CHECK (
    scope NOT IN ('participant', 'read_status') OR kind <> 'system'
  ),
  -- Only messages have per-row ids; the other scopes are keyed by the thread
  -- (creator, closer) or by (thread, slug) (participant, read_status).
  CONSTRAINT inkmail_cutover_principal_row_only_for_messages CHECK (
    row_id IS NULL OR scope = 'message'
  )
);

CREATE UNIQUE INDEX inkmail_cutover_principal_attestations_key
  ON public.inkmail_cutover_principal_attestations (
    scope, thread_id, legacy_id, COALESCE(row_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Operator-only: the manifests name people. RLS on with no policy means only
-- the service role (which bypasses RLS) can read or write them.
ALTER TABLE public.inkmail_cutover_thread_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inkmail_cutover_principal_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inkmail_cutover_thread_attestations FROM anon, authenticated;
REVOKE ALL ON public.inkmail_cutover_principal_attestations FROM anon, authenticated;

-- ── 2. Helpers ─────────────────────────────────────────────────────────────

-- A user's active personal workspace, when there is exactly one. NULL when
-- there is none or several — the cutover provisions the missing ones and
-- the preflight reports the rest.
CREATE OR REPLACE FUNCTION public.inkmail_cutover_personal_workspace(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(w.id))[1] END
  FROM public.workspaces w
  WHERE w.user_id = p_user_id
    AND w.type = 'personal'
    AND w.slug = 'personal'
    AND w.archived_at IS NULL;
$$;

-- The attestation that applies to each message: the row-level one when it
-- exists, otherwise the batch for (thread, 'message', sender slug).
CREATE OR REPLACE FUNCTION public.inkmail_cutover_effective_message_attestations()
RETURNS TABLE (message_id uuid, attestation_id uuid)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT m.id, a.id
  FROM public.inbox_thread_messages m
  LEFT JOIN LATERAL (
    SELECT pa.id
    FROM public.inkmail_cutover_principal_attestations pa
    WHERE pa.scope = 'message'
      AND pa.thread_id = m.thread_id
      AND pa.legacy_id = m.sender_agent_id
      AND (pa.row_id IS NULL OR pa.row_id = m.id)
    ORDER BY (pa.row_id IS NULL) ASC
    LIMIT 1
  ) a ON true;
$$;

-- Resolve an attested principal inside a workspace. `problem` is NULL when
-- the attestation resolves; otherwise it says why it does not.
--   sb:     exactly one identity in the workspace matching the given id
--           and/or slug, owned by a member of the workspace (§4a.1);
--   user:   a member of the workspace;
--   system: nobody, by definition.
CREATE OR REPLACE FUNCTION public.inkmail_cutover_resolve_principal(
  p_kind text,
  p_sb_id uuid,
  p_sb_agent_id text,
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (sb_id uuid, user_id uuid, problem text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'thread has no attested workspace';
    RETURN;
  END IF;
  IF p_kind = 'system' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  IF p_kind = 'user' THEN
    IF EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = p_workspace_id AND wm.user_id = p_user_id
    ) THEN
      RETURN QUERY SELECT NULL::uuid, p_user_id, NULL::text;
    ELSE
      RETURN QUERY SELECT NULL::uuid, NULL::uuid,
        format('user %s is not a member of workspace %s', p_user_id, p_workspace_id);
    END IF;
    RETURN;
  END IF;
  -- kind = 'sb'
  SELECT array_agg(ai.id) INTO v_ids
  FROM public.agent_identities ai
  JOIN public.workspace_members wm
    ON wm.workspace_id = ai.workspace_id AND wm.user_id = ai.user_id
  WHERE ai.workspace_id = p_workspace_id
    AND (p_sb_id IS NULL OR ai.id = p_sb_id)
    AND (p_sb_agent_id IS NULL OR ai.agent_id = p_sb_agent_id);
  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      format('no identity in workspace %s matches sb_id=%s slug=%s owned by a member',
             p_workspace_id, p_sb_id, p_sb_agent_id);
  ELSIF array_length(v_ids, 1) > 1 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid,
      format('%s identities in workspace %s match slug=%s',
             array_length(v_ids, 1), p_workspace_id, p_sb_agent_id);
  ELSE
    RETURN QUERY SELECT v_ids[1], NULL::uuid, NULL::text;
  END IF;
END;
$$;

-- ── 3. Suggestions (drafts for the reviewer; never read by the cutover) ────

-- Thread → workspace candidates (§4a.1). The legacy owner's personal
-- workspace is the default candidate when the owner belongs to exactly one
-- workspace. An owner in several workspaces gets no suggestion: every
-- membership check would pass for either, so "checks passed" is not
-- "attributed" (fixture (a)).
CREATE OR REPLACE FUNCTION public.inkmail_cutover_suggest_threads()
RETURNS TABLE (
  thread_id uuid,
  thread_key text,
  owner_user_id uuid,
  owner_workspace_count bigint,
  suggested_workspace_id uuid,
  participants text[]
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT t.id,
         t.thread_key,
         t.user_id,
         (SELECT count(*) FROM public.workspace_members wm WHERE wm.user_id = t.user_id),
         CASE
           WHEN (SELECT count(*) FROM public.workspace_members wm WHERE wm.user_id = t.user_id) = 1
             THEN public.inkmail_cutover_personal_workspace(t.user_id)
           ELSE NULL
         END,
         ARRAY(SELECT p.agent_id FROM public.inbox_thread_participants p
               WHERE p.thread_id = t.id ORDER BY p.agent_id)
  FROM public.inbox_threads t
  ORDER BY t.created_at;
$$;

-- Principal candidates (§4a.2), one row per (thread, scope, legacy slug)
-- batch, with the class the markers suggest. Resolution uses the thread's
-- ATTESTED workspace when one is loaded, else the thread suggestion above.
--   SB candidate:    slug other than 'system'/'unknown' → the single identity
--                    it resolves to in that workspace, or none;
--   human candidate: 'unknown' with metadata.sentBy = 'user' → the owner;
--   system candidate: 'system';
--   none:            everything else.
CREATE OR REPLACE FUNCTION public.inkmail_cutover_suggest_principals()
RETURNS TABLE (
  scope text,
  thread_id uuid,
  thread_key text,
  legacy_id text,
  row_count bigint,
  suggested_kind text,
  suggested_sb_id uuid,
  suggested_user_id uuid,
  hint text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH ws AS (
    SELECT t.id AS thread_id, t.thread_key, t.user_id AS owner_user_id,
           COALESCE(
             (SELECT ta.workspace_id FROM public.inkmail_cutover_thread_attestations ta WHERE ta.thread_id = t.id),
             (SELECT s.suggested_workspace_id FROM public.inkmail_cutover_suggest_threads() s WHERE s.thread_id = t.id)
           ) AS workspace_id
    FROM public.inbox_threads t
  ),
  legacy AS (
    SELECT 'message'::text AS scope, m.thread_id, m.sender_agent_id AS legacy_id,
           bool_or(m.metadata ->> 'sentBy' = 'user') AS any_user_marker, count(*) AS row_count
    FROM public.inbox_thread_messages m GROUP BY m.thread_id, m.sender_agent_id
    UNION ALL
    SELECT 'participant', p.thread_id, p.agent_id, false, 1
    FROM public.inbox_thread_participants p
    UNION ALL
    SELECT 'read_status', rs.thread_id, rs.agent_id, false, 1
    FROM public.inbox_thread_read_status rs
    UNION ALL
    SELECT 'creator', t.id, t.created_by_agent_id, false, 1
    FROM public.inbox_threads t
    UNION ALL
    SELECT 'closer', t.id, t.closed_by_agent_id, false, 1
    FROM public.inbox_threads t
    WHERE t.closed_at IS NOT NULL AND t.closed_by_agent_id IS NOT NULL
  )
  SELECT l.scope, l.thread_id, ws.thread_key, l.legacy_id, l.row_count,
         CASE
           WHEN l.legacy_id = 'system' THEN 'system'
           WHEN l.legacy_id = 'unknown' AND l.any_user_marker THEN 'user'
           WHEN l.legacy_id NOT IN ('system', 'unknown') AND r.sb_id IS NOT NULL THEN 'sb'
           ELSE NULL
         END,
         CASE WHEN l.legacy_id NOT IN ('system', 'unknown') THEN r.sb_id END,
         CASE WHEN l.legacy_id = 'unknown' AND l.any_user_marker THEN ws.owner_user_id END,
         CASE
           WHEN l.legacy_id = 'system' THEN 'sender stamp is system; shape is a hint, not provenance'
           WHEN l.legacy_id = 'unknown' AND l.any_user_marker THEN 'human marker via the admin route; owner is the suggestion, never the written value'
           WHEN l.legacy_id = 'unknown' THEN 'unknown without a marker: no candidate'
           WHEN r.sb_id IS NOT NULL THEN 'slug resolves to exactly one identity in the workspace'
           ELSE COALESCE(r.problem, 'no workspace to resolve in')
         END
  FROM legacy l
  JOIN ws ON ws.thread_id = l.thread_id
  LEFT JOIN LATERAL public.inkmail_cutover_resolve_principal('sb', NULL, l.legacy_id, NULL, ws.workspace_id) r ON true
  ORDER BY ws.thread_key, l.scope, l.legacy_id;
END;
$$;

-- ── 4. Preflight ───────────────────────────────────────────────────────────

-- Every finding that would abort the cutover. Empty means the manifests cover
-- production and nothing they say is contradicted. `check_name` values are
-- stable identifiers (tests pin them); `suggestion` is the reviewer's hint.
CREATE OR REPLACE FUNCTION public.inkmail_cutover_preflight()
RETURNS TABLE (
  check_name text,
  thread_id uuid,
  row_id uuid,
  scope text,
  legacy_id text,
  suggestion text,
  detail text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  -- Users without exactly one active personal workspace. The cutover
  -- provisions the missing ones before it runs this preflight, so at abort
  -- time this lists only users with SEVERAL — a state the operator resolves.
  RETURN QUERY
  SELECT 'user_without_personal_workspace', NULL::uuid, NULL::uuid, NULL::text, NULL::text,
         NULL::text,
         format('user %s has %s active personal workspaces', u.id,
                (SELECT count(*) FROM public.workspaces w
                 WHERE w.user_id = u.id AND w.type = 'personal' AND w.slug = 'personal' AND w.archived_at IS NULL))
  FROM public.users u
  WHERE public.inkmail_cutover_personal_workspace(u.id) IS NULL;

  -- §4a.1 Threads without a workspace attestation.
  RETURN QUERY
  SELECT 'thread_unattested', s.thread_id, NULL::uuid, NULL::text, NULL::text,
         s.suggested_workspace_id::text,
         format('key=%s owner=%s participants=%s owner_workspaces=%s',
                s.thread_key, s.owner_user_id, array_to_string(s.participants, ','), s.owner_workspace_count)
  FROM public.inkmail_cutover_suggest_threads() s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inkmail_cutover_thread_attestations ta WHERE ta.thread_id = s.thread_id
  );

  -- Attestations that name a thread that does not exist.
  RETURN QUERY
  SELECT 'thread_attestation_orphan', ta.thread_id, NULL::uuid, NULL::text, NULL::text, NULL::text,
         format('no inbox_threads row with id %s', ta.thread_id)
  FROM public.inkmail_cutover_thread_attestations ta
  WHERE NOT EXISTS (SELECT 1 FROM public.inbox_threads t WHERE t.id = ta.thread_id);

  -- Attested workspace missing or archived.
  RETURN QUERY
  SELECT 'thread_workspace_missing', ta.thread_id, NULL::uuid, NULL::text, NULL::text, NULL::text,
         format('workspace %s does not exist or is archived', ta.workspace_id)
  FROM public.inkmail_cutover_thread_attestations ta
  WHERE NOT EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.id = ta.workspace_id AND w.archived_at IS NULL
  );

  -- Candidate validation: the legacy owner must be a member of the attested
  -- workspace.
  RETURN QUERY
  SELECT 'thread_owner_not_member', t.id, NULL::uuid, NULL::text, NULL::text, NULL::text,
         format('owner %s is not a member of attested workspace %s', t.user_id, ta.workspace_id)
  FROM public.inbox_threads t
  JOIN public.inkmail_cutover_thread_attestations ta ON ta.thread_id = t.id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = ta.workspace_id AND wm.user_id = t.user_id
  );

  -- Candidate validation: every SB participant slug must resolve to exactly
  -- one identity in the attested workspace owned by a member. A participant
  -- attested as a human is exempt.
  RETURN QUERY
  SELECT 'thread_participant_slug_unresolved', p.thread_id, NULL::uuid, 'participant', p.agent_id,
         NULL::text, r.problem
  FROM public.inbox_thread_participants p
  JOIN public.inkmail_cutover_thread_attestations ta ON ta.thread_id = p.thread_id
  LEFT JOIN public.inkmail_cutover_principal_attestations pa
    ON pa.scope = 'participant' AND pa.thread_id = p.thread_id AND pa.legacy_id = p.agent_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal('sb', NULL, p.agent_id, NULL, ta.workspace_id) r
  WHERE COALESCE(pa.kind, 'sb') = 'sb' AND r.problem IS NOT NULL;

  -- §4a.3 Duplicate (workspace, thread_key) groups after attribution.
  RETURN QUERY
  SELECT 'thread_key_duplicate', t.id, NULL::uuid, NULL::text, t.thread_key, NULL::text,
         format('%s threads carry key %s in workspace %s; last message %s',
                d.n, t.thread_key, ta.workspace_id,
                (SELECT max(m.created_at) FROM public.inbox_thread_messages m WHERE m.thread_id = t.id))
  FROM public.inbox_threads t
  JOIN public.inkmail_cutover_thread_attestations ta ON ta.thread_id = t.id
  JOIN (
    SELECT ta2.workspace_id, t2.thread_key, count(*) AS n
    FROM public.inbox_threads t2
    JOIN public.inkmail_cutover_thread_attestations ta2 ON ta2.thread_id = t2.id
    GROUP BY ta2.workspace_id, t2.thread_key
    HAVING count(*) > 1
  ) d ON d.workspace_id = ta.workspace_id AND d.thread_key = t.thread_key;

  -- §1c Identity slug collisions inside a workspace.
  RETURN QUERY
  SELECT 'identity_slug_collision', NULL::uuid, ai.id, 'identity', ai.agent_id, NULL::text,
         format('%s identities named %s in workspace %s (this one: user %s)',
                c.n, ai.agent_id, ai.workspace_id, ai.user_id)
  FROM public.agent_identities ai
  JOIN (
    SELECT workspace_id, agent_id, count(*) AS n
    FROM public.agent_identities
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id, agent_id
    HAVING count(*) > 1
  ) c ON c.workspace_id = ai.workspace_id AND c.agent_id = ai.agent_id;

  -- §4a.2 Legacy rows without an attestation, per scope, with the class the
  -- markers suggest. Messages are listed per row (the migration aborts with
  -- row ids); the other scopes are keyed by thread or (thread, slug).
  RETURN QUERY
  SELECT 'principal_unattested', m.thread_id, m.id, 'message', m.sender_agent_id,
         CASE sp.suggested_kind
           WHEN 'sb' THEN 'sb:' || sp.suggested_sb_id
           WHEN 'user' THEN 'user:' || sp.suggested_user_id
           WHEN 'system' THEN 'system'
         END,
         COALESCE(sp.hint, 'no candidate')
  FROM public.inbox_thread_messages m
  JOIN public.inkmail_cutover_effective_message_attestations() ea ON ea.message_id = m.id
  LEFT JOIN public.inkmail_cutover_suggest_principals() sp
    ON sp.scope = 'message' AND sp.thread_id = m.thread_id AND sp.legacy_id = m.sender_agent_id
  WHERE ea.attestation_id IS NULL;

  RETURN QUERY
  SELECT 'principal_unattested', p.thread_id, NULL::uuid, 'participant', p.agent_id,
         CASE sp.suggested_kind WHEN 'sb' THEN 'sb:' || sp.suggested_sb_id END,
         COALESCE(sp.hint, 'no candidate')
  FROM public.inbox_thread_participants p
  LEFT JOIN public.inkmail_cutover_suggest_principals() sp
    ON sp.scope = 'participant' AND sp.thread_id = p.thread_id AND sp.legacy_id = p.agent_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inkmail_cutover_principal_attestations pa
    WHERE pa.scope = 'participant' AND pa.thread_id = p.thread_id AND pa.legacy_id = p.agent_id
  );

  RETURN QUERY
  SELECT 'principal_unattested', rs.thread_id, NULL::uuid, 'read_status', rs.agent_id,
         CASE sp.suggested_kind WHEN 'sb' THEN 'sb:' || sp.suggested_sb_id END,
         COALESCE(sp.hint, 'no candidate')
  FROM public.inbox_thread_read_status rs
  LEFT JOIN public.inkmail_cutover_suggest_principals() sp
    ON sp.scope = 'read_status' AND sp.thread_id = rs.thread_id AND sp.legacy_id = rs.agent_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inkmail_cutover_principal_attestations pa
    WHERE pa.scope = 'read_status' AND pa.thread_id = rs.thread_id AND pa.legacy_id = rs.agent_id
  );

  RETURN QUERY
  SELECT 'principal_unattested', t.id, NULL::uuid, 'creator', t.created_by_agent_id,
         CASE sp.suggested_kind
           WHEN 'sb' THEN 'sb:' || sp.suggested_sb_id
           WHEN 'system' THEN 'system'
         END,
         COALESCE(sp.hint, 'no candidate')
  FROM public.inbox_threads t
  LEFT JOIN public.inkmail_cutover_suggest_principals() sp
    ON sp.scope = 'creator' AND sp.thread_id = t.id AND sp.legacy_id = t.created_by_agent_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inkmail_cutover_principal_attestations pa
    WHERE pa.scope = 'creator' AND pa.thread_id = t.id AND pa.legacy_id = t.created_by_agent_id
  );

  -- Closure is an event that may not have happened: only a CLOSED thread
  -- needs a closer (§3, §4a.2). A closed thread with no closer slug is a
  -- contradiction the operator must look at, listed under the same check.
  RETURN QUERY
  SELECT 'principal_unattested', t.id, NULL::uuid, 'closer', COALESCE(t.closed_by_agent_id, ''),
         CASE sp.suggested_kind
           WHEN 'sb' THEN 'sb:' || sp.suggested_sb_id
           WHEN 'system' THEN 'system'
         END,
         CASE WHEN t.closed_by_agent_id IS NULL
              THEN 'closed_at set but closed_by_agent_id is NULL'
              ELSE COALESCE(sp.hint, 'no candidate') END
  FROM public.inbox_threads t
  LEFT JOIN public.inkmail_cutover_suggest_principals() sp
    ON sp.scope = 'closer' AND sp.thread_id = t.id AND sp.legacy_id = t.closed_by_agent_id
  WHERE t.closed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.inkmail_cutover_principal_attestations pa
      WHERE pa.scope = 'closer' AND pa.thread_id = t.id AND pa.legacy_id = t.closed_by_agent_id
    );

  -- Attestations that match nothing (wrong thread, wrong slug, wrong row).
  RETURN QUERY
  SELECT 'principal_attestation_orphan', pa.thread_id, pa.row_id, pa.scope, pa.legacy_id, NULL::text,
         'attestation matches no legacy row'
  FROM public.inkmail_cutover_principal_attestations pa
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inbox_threads t WHERE t.id = pa.thread_id
  ) OR NOT (
    CASE pa.scope
      WHEN 'message' THEN EXISTS (
        SELECT 1 FROM public.inbox_thread_messages m
        WHERE m.thread_id = pa.thread_id AND m.sender_agent_id = pa.legacy_id
          AND (pa.row_id IS NULL OR m.id = pa.row_id))
      WHEN 'participant' THEN EXISTS (
        SELECT 1 FROM public.inbox_thread_participants p
        WHERE p.thread_id = pa.thread_id AND p.agent_id = pa.legacy_id)
      WHEN 'read_status' THEN EXISTS (
        SELECT 1 FROM public.inbox_thread_read_status rs
        WHERE rs.thread_id = pa.thread_id AND rs.agent_id = pa.legacy_id)
      WHEN 'creator' THEN EXISTS (
        SELECT 1 FROM public.inbox_threads t
        WHERE t.id = pa.thread_id AND t.created_by_agent_id = pa.legacy_id)
      WHEN 'closer' THEN EXISTS (
        SELECT 1 FROM public.inbox_threads t
        WHERE t.id = pa.thread_id AND t.closed_by_agent_id = pa.legacy_id)
    END
  );

  -- A closer attested for a thread that is not closed: the absent closure
  -- is not an unresolved closer, and no actor is minted for it.
  RETURN QUERY
  SELECT 'closer_attested_on_open_thread', pa.thread_id, NULL::uuid, 'closer', pa.legacy_id, NULL::text,
         'thread has closed_at IS NULL; the attestation would mint a closer for no closure'
  FROM public.inkmail_cutover_principal_attestations pa
  JOIN public.inbox_threads t ON t.id = pa.thread_id
  WHERE pa.scope = 'closer' AND t.closed_at IS NULL;

  -- Attestations that do not resolve inside the thread's attested workspace
  -- (SB not there or ambiguous, user not a member, thread unattested).
  RETURN QUERY
  SELECT 'principal_attestation_unresolved', pa.thread_id, pa.row_id, pa.scope, pa.legacy_id, NULL::text,
         r.problem
  FROM public.inkmail_cutover_principal_attestations pa
  LEFT JOIN public.inkmail_cutover_thread_attestations ta ON ta.thread_id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, ta.workspace_id) r
  WHERE r.problem IS NOT NULL;

  -- §3: a human participant row carries no session stamp. A legacy row
  -- attested as a person while it holds a session is a contradiction.
  RETURN QUERY
  SELECT 'participant_user_attested_with_session', p.thread_id, NULL::uuid, 'participant', p.agent_id,
         NULL::text,
         format('attested as user %s but session_id %s is set', pa.user_id, p.session_id)
  FROM public.inbox_thread_participants p
  JOIN public.inkmail_cutover_principal_attestations pa
    ON pa.scope = 'participant' AND pa.thread_id = p.thread_id AND pa.legacy_id = p.agent_id
  WHERE pa.kind = 'user' AND p.session_id IS NOT NULL;

  -- Two legacy slugs in one thread attested to the same principal would
  -- collide on (thread, principal). Merging pointers is explicitly not in v1
  -- (§4a.3), so this aborts rather than picking one.
  RETURN QUERY
  WITH mapped AS (
    SELECT pa.scope, pa.thread_id, pa.legacy_id,
           COALESCE('sb:' || r.sb_id::text, 'user:' || r.user_id::text) AS principal_key
    FROM public.inkmail_cutover_principal_attestations pa
    JOIN public.inkmail_cutover_thread_attestations ta ON ta.thread_id = pa.thread_id
    CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
      pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, ta.workspace_id) r
    WHERE pa.scope IN ('participant', 'read_status') AND r.problem IS NULL
  )
  SELECT 'principal_duplicate_after_mapping', m.thread_id, NULL::uuid, m.scope, m.legacy_id, NULL::text,
         format('%s legacy rows in this thread map to %s', d.n, m.principal_key)
  FROM mapped m
  JOIN (
    SELECT mm.scope, mm.thread_id, mm.principal_key, count(*) AS n
    FROM mapped mm GROUP BY mm.scope, mm.thread_id, mm.principal_key HAVING count(*) > 1
  ) d ON d.scope = m.scope AND d.thread_id = m.thread_id AND d.principal_key = m.principal_key;
END;
$$;

COMMENT ON FUNCTION public.inkmail_cutover_preflight() IS
  'Read-only listing of every finding that would abort the inkmail thread-scope cutover (spec inkmail-thread-scope §4a). Empty = the loaded manifests cover production and nothing is contradicted.';
