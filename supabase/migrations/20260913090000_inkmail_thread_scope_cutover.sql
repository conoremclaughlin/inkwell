-- Inkmail thread scope — the cutover
-- Spec: ink://specs/inkmail-thread-scope §1, §1b, §1c, §3, §4, §4a (v9, approved 2026-09-12)
--
-- ONE TRANSACTION, WRITERS STOPPED. Apply with `supabase db push` (one
-- transaction per migration file) after loading the attestation manifests
-- into the staging tables of 20260913081634. Any RAISE below rolls this whole
-- file back and leaves the pre-cutover schema intact: the old binary starts
-- against it as if nothing had happened (§4). A failure AFTER commit is a
-- deployment problem, decided before the window: forward-fix while stopped
-- by default, restore from the step-2 snapshot as the fallback.
--
-- Nothing below infers provenance. Threads take the workspace the manifest
-- attests; rows take the author the manifest attests; a slug names an SB
-- only by resolving to exactly one identity in the thread's attested
-- workspace. Missing evidence aborts (step 1); so does contradicted evidence.
--
-- Order (§4.3):
--    0. provision the missing personal workspaces (per user — not a thread attribution)
--    1. preflight: abort with row ids on any finding
--    2. add workspace_id and the principal columns; drop created_by_agent_id's NOT NULL
--    3. threads → workspaces, from the manifest only
--    4. principals, from the manifest only (row over batch)
--    5. the §1b namespace move, in full
--    6. constraints: NOT NULLs, the CHECKs of §3, UNIQUE (workspace_id, thread_key),
--       UNIQUE (workspace_id, agent_id), the composite FKs of §1c
--    7. SQL readers and writers rewritten for the new columns
--    8. drop the legacy columns
--    9. DB-level personal-workspace provisioning (§1)
--   10. drop the staging tables and helpers

-- ── 0. Personal workspaces ─────────────────────────────────────────────────
-- Every user has one (§1). Provisioning one for a user who lacks it is a
-- per-user fact, not a thread attribution: it decides nothing about which
-- workspace any thread belongs to.
INSERT INTO public.workspaces (user_id, name, slug, type)
SELECT u.id, 'Personal', 'personal', 'personal'
FROM public.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.workspaces w
  WHERE w.user_id = u.id AND w.type = 'personal' AND w.slug = 'personal' AND w.archived_at IS NULL
);

INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT w.id, w.user_id, 'owner'
FROM public.workspaces w
WHERE w.type = 'personal' AND w.slug = 'personal' AND w.archived_at IS NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- ── 1. Preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count bigint;
  v_sample text;
BEGIN
  SELECT count(*),
         string_agg(
           format('%s thread=%s row=%s scope=%s legacy=%s suggestion=%s: %s',
                  f.check_name, f.thread_id, f.row_id, f.scope, f.legacy_id, f.suggestion, f.detail),
           E'\n' ORDER BY f.rn
         ) FILTER (WHERE f.rn <= 50)
    INTO v_count, v_sample
  FROM (
    SELECT p.*, row_number() OVER (ORDER BY p.check_name, p.thread_id, p.scope, p.legacy_id, p.row_id) AS rn
    FROM public.inkmail_cutover_preflight() p
  ) f;
  IF v_count > 0 THEN
    RAISE EXCEPTION E'inkmail thread-scope cutover: preflight found % finding(s); nothing was changed. First %:\n%',
      v_count, LEAST(v_count, 50), v_sample;
  END IF;
END $$;

-- ── 2. Columns ─────────────────────────────────────────────────────────────
ALTER TABLE public.inbox_threads
  ADD COLUMN workspace_id uuid,
  ADD COLUMN created_by_kind text,
  ADD COLUMN created_by_sb_id uuid,
  ADD COLUMN created_by_user_id uuid,
  ADD COLUMN closed_by_kind text,
  ADD COLUMN closed_by_sb_id uuid,
  ADD COLUMN closed_by_user_id uuid,
  -- A human-created thread cannot satisfy a NOT NULL slug without a
  -- sentinel (§3); the column goes entirely in step 8.
  ALTER COLUMN created_by_agent_id DROP NOT NULL;

ALTER TABLE public.inbox_thread_participants
  ADD COLUMN workspace_id uuid,
  ADD COLUMN sb_id uuid,
  ADD COLUMN user_id uuid,
  -- One conflict target for humans and SBs alike ('sb:<uuid>' | 'user:<uuid>').
  -- The two partial unique indexes of §3 express the same invariant; a
  -- single real constraint is what PostgREST's on_conflict can name.
  ADD COLUMN principal_key text GENERATED ALWAYS AS (
    CASE WHEN sb_id IS NOT NULL THEN 'sb:' || sb_id::text
         WHEN user_id IS NOT NULL THEN 'user:' || user_id::text END
  ) STORED;

ALTER TABLE public.inbox_thread_messages
  ADD COLUMN sender_kind text,
  ADD COLUMN sender_sb_id uuid,
  ADD COLUMN sender_user_id uuid,
  -- Retained as a display slug for SB rows only (§3: display rule, never a
  -- delivery rule). NULL for people and for the system.
  ALTER COLUMN sender_agent_id DROP NOT NULL;

ALTER TABLE public.inbox_thread_read_status
  ADD COLUMN sb_id uuid,
  ADD COLUMN user_id uuid,
  ADD COLUMN principal_key text GENERATED ALWAYS AS (
    CASE WHEN sb_id IS NOT NULL THEN 'sb:' || sb_id::text
         WHEN user_id IS NOT NULL THEN 'user:' || user_id::text END
  ) STORED;

-- Backfills are not thread activity and must not reorder inboxes; the pin
-- recompute in step 5 is a sanctioned one-time repair (precedent:
-- 20260820183006). Both re-enabled below.
ALTER TABLE public.inbox_threads DISABLE TRIGGER update_inbox_threads_updated_at;
ALTER TABLE public.inbox_threads DISABLE TRIGGER enforce_thread_key_immutability;

-- ── 3. Threads → workspaces ────────────────────────────────────────────────
UPDATE public.inbox_threads t
   SET workspace_id = ta.workspace_id
  FROM public.inkmail_cutover_thread_attestations ta
 WHERE ta.thread_id = t.id;

UPDATE public.inbox_thread_participants p
   SET workspace_id = t.workspace_id
  FROM public.inbox_threads t
 WHERE t.id = p.thread_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inbox_threads WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'cutover: % thread(s) left without a workspace after attestation',
      (SELECT count(*) FROM public.inbox_threads WHERE workspace_id IS NULL);
  END IF;
END $$;

-- ── 4. Principals ──────────────────────────────────────────────────────────
-- Messages: the row-level attestation when there is one, else the batch.
UPDATE public.inbox_thread_messages m
   SET sender_kind = pa.kind,
       sender_sb_id = r.sb_id,
       sender_user_id = r.user_id,
       sender_agent_id = CASE WHEN pa.kind = 'sb' THEN ai.agent_id END
  FROM public.inkmail_cutover_effective_message_attestations() ea
  JOIN public.inkmail_cutover_principal_attestations pa ON pa.id = ea.attestation_id
  JOIN public.inbox_threads t ON t.id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, t.workspace_id) r
  LEFT JOIN public.agent_identities ai ON ai.id = r.sb_id
 WHERE m.id = ea.message_id;

UPDATE public.inbox_thread_participants p
   SET sb_id = r.sb_id,
       user_id = r.user_id
  FROM public.inkmail_cutover_principal_attestations pa
  JOIN public.inbox_threads t ON t.id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, t.workspace_id) r
 WHERE pa.scope = 'participant' AND pa.thread_id = p.thread_id AND pa.legacy_id = p.agent_id;

UPDATE public.inbox_thread_read_status rs
   SET sb_id = r.sb_id,
       user_id = r.user_id
  FROM public.inkmail_cutover_principal_attestations pa
  JOIN public.inbox_threads t ON t.id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, t.workspace_id) r
 WHERE pa.scope = 'read_status' AND pa.thread_id = rs.thread_id AND pa.legacy_id = rs.agent_id;

UPDATE public.inbox_threads t
   SET created_by_kind = pa.kind,
       created_by_sb_id = r.sb_id,
       created_by_user_id = r.user_id
  FROM public.inkmail_cutover_principal_attestations pa
  JOIN public.inbox_threads t2 ON t2.id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, t2.workspace_id) r
 WHERE pa.scope = 'creator' AND pa.thread_id = t.id AND pa.legacy_id = t.created_by_agent_id;

-- Closure is an event that may not have happened: only a closed thread has
-- a closer; an open one migrates with every closer column null (§3, §4a.2).
UPDATE public.inbox_threads t
   SET closed_by_kind = pa.kind,
       closed_by_sb_id = r.sb_id,
       closed_by_user_id = r.user_id
  FROM public.inkmail_cutover_principal_attestations pa
  JOIN public.inbox_threads t2 ON t2.id = pa.thread_id
  CROSS JOIN LATERAL public.inkmail_cutover_resolve_principal(
    pa.kind, pa.sb_id, pa.sb_agent_id, pa.user_id, t2.workspace_id) r
 WHERE pa.scope = 'closer' AND pa.thread_id = t.id
   AND t.closed_at IS NOT NULL AND pa.legacy_id = t.closed_by_agent_id;

DO $$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.inbox_thread_messages WHERE sender_kind IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'cutover: % message(s) left without an author', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.inbox_thread_participants WHERE sb_id IS NULL AND user_id IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'cutover: % participant row(s) left without a principal', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.inbox_thread_read_status WHERE sb_id IS NULL AND user_id IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'cutover: % read pointer(s) left without a principal', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.inbox_threads WHERE created_by_kind IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'cutover: % thread(s) left without a creator', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.inbox_threads WHERE closed_at IS NOT NULL AND closed_by_kind IS NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'cutover: % closed thread(s) left without a closer', v_n; END IF;
END $$;

-- ── 5. The §1b namespace move, in full ─────────────────────────────────────
-- A project belongs to its owner's personal workspace. This is a per-user
-- fact about the registry, decided here for every project the same way; it
-- is not evidence about any thread (§4a: a namespace value the cutover
-- computes cannot justify a thread's assignment, and none is used that way).
ALTER TABLE public.projects DISABLE TRIGGER update_projects_updated_at;
ALTER TABLE public.projects ADD COLUMN workspace_id uuid;
UPDATE public.projects p SET workspace_id = public.inkmail_cutover_personal_workspace(p.user_id);
ALTER TABLE public.projects ENABLE TRIGGER update_projects_updated_at;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'cutover: % project(s) whose owner has no single personal workspace',
      (SELECT count(*) FROM public.projects WHERE workspace_id IS NULL);
  END IF;
END $$;
ALTER TABLE public.projects
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT projects_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE INDEX idx_projects_workspace_id ON public.projects (workspace_id);
-- The namespace is the workspace now: one owner may use one slug in two of
-- their workspaces, so the per-user uniqueness goes (Lumen, #616 P2).
DROP INDEX public.projects_user_slug;
CREATE UNIQUE INDEX projects_workspace_slug
  ON public.projects (workspace_id, slug) WHERE slug IS NOT NULL;

-- Aliases live in their project's workspace.
ALTER TABLE public.project_slug_aliases DISABLE TRIGGER enforce_alias_namespace;
ALTER TABLE public.project_slug_aliases DISABLE TRIGGER enforce_alias_target_integrity;
ALTER TABLE public.project_slug_aliases ADD COLUMN workspace_id uuid;
UPDATE public.project_slug_aliases a
   SET workspace_id = p.workspace_id
  FROM public.projects p
 WHERE p.id = a.project_id;
ALTER TABLE public.project_slug_aliases ENABLE TRIGGER enforce_alias_namespace;
ALTER TABLE public.project_slug_aliases ENABLE TRIGGER enforce_alias_target_integrity;
ALTER TABLE public.project_slug_aliases
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT project_slug_aliases_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT project_slug_aliases_workspace_alias_key UNIQUE (workspace_id, alias),
  DROP CONSTRAINT project_slug_aliases_user_id_alias_key;

-- Thread-key types: NULL workspace = global template, exactly the shape the
-- per-user override used (two partial unique indexes). user_id goes.
ALTER TABLE public.thread_key_types DISABLE TRIGGER update_thread_key_types_updated_at;
ALTER TABLE public.thread_key_types ADD COLUMN workspace_id uuid;
UPDATE public.thread_key_types tk
   SET workspace_id = public.inkmail_cutover_personal_workspace(tk.user_id)
 WHERE tk.user_id IS NOT NULL;
ALTER TABLE public.thread_key_types ENABLE TRIGGER update_thread_key_types_updated_at;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.thread_key_types WHERE user_id IS NOT NULL AND workspace_id IS NULL) THEN
    RAISE EXCEPTION 'cutover: % thread-key type override(s) whose owner has no single personal workspace',
      (SELECT count(*) FROM public.thread_key_types WHERE user_id IS NOT NULL AND workspace_id IS NULL);
  END IF;
END $$;
DROP TRIGGER enforce_type_not_project_slug ON public.thread_key_types;
ALTER TABLE public.thread_key_types DROP COLUMN user_id;
ALTER TABLE public.thread_key_types
  ADD CONSTRAINT thread_key_types_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX thread_key_types_template_type
  ON public.thread_key_types (type) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX thread_key_types_workspace_type
  ON public.thread_key_types (workspace_id, type) WHERE workspace_id IS NOT NULL;

-- Namespace integrity, now keyed by workspace. Same advisory-lock family, so
-- the three tables still serialize on the contested name.
CREATE OR REPLACE FUNCTION public.enforce_type_not_project_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.type));
  IF NEW.workspace_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.slug = NEW.type) THEN
      RAISE EXCEPTION 'type name "%" collides with an existing project slug', NEW.type;
    END IF;
    IF EXISTS (SELECT 1 FROM public.project_slug_aliases a WHERE a.alias = NEW.type) THEN
      RAISE EXCEPTION 'type name "%" collides with an existing project slug alias', NEW.type;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.projects p WHERE p.workspace_id = NEW.workspace_id AND p.slug = NEW.type
    ) THEN
      RAISE EXCEPTION 'type name "%" collides with a project slug in this workspace', NEW.type;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.project_slug_aliases a
      WHERE a.workspace_id = NEW.workspace_id AND a.alias = NEW.type
    ) THEN
      RAISE EXCEPTION 'type name "%" collides with a project slug alias in this workspace', NEW.type;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_type_not_project_slug
  BEFORE INSERT OR UPDATE OF type, workspace_id ON public.thread_key_types
  FOR EACH ROW EXECUTE FUNCTION public.enforce_type_not_project_slug();

CREATE OR REPLACE FUNCTION public.enforce_project_slug_not_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.slug IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.slug));
  IF EXISTS (
    SELECT 1 FROM public.thread_key_types t
    WHERE t.type = NEW.slug AND (t.workspace_id IS NULL OR t.workspace_id = NEW.workspace_id)
  ) THEN
    RAISE EXCEPTION 'project slug "%" collides with a registered thread-key type', NEW.slug;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.project_slug_aliases a
    WHERE a.workspace_id = NEW.workspace_id AND a.alias = NEW.slug AND a.project_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'project slug "%" collides with another project''s slug alias', NEW.slug;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_project_slug_not_type ON public.projects;
CREATE TRIGGER enforce_project_slug_not_type
  BEFORE INSERT OR UPDATE OF slug, workspace_id ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_slug_not_type();

CREATE OR REPLACE FUNCTION public.enforce_alias_namespace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tk-namespace:' || NEW.alias));
  IF EXISTS (
    SELECT 1 FROM public.thread_key_types t
    WHERE t.type = NEW.alias AND (t.workspace_id IS NULL OR t.workspace_id = NEW.workspace_id)
  ) THEN
    RAISE EXCEPTION 'alias "%" collides with a registered thread-key type', NEW.alias;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.workspace_id = NEW.workspace_id AND p.slug = NEW.alias
  ) THEN
    RAISE EXCEPTION 'alias "%" collides with an existing project slug', NEW.alias;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_alias_target_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_workspace uuid;
  v_slug text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('project-alias:' || NEW.project_id::text));
  SELECT p.user_id, p.workspace_id, p.slug INTO v_owner, v_workspace, v_slug
  FROM public.projects p WHERE p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alias "%" targets a project that does not exist', NEW.alias;
  END IF;
  IF v_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'alias "%" must belong to the target project''s owner', NEW.alias;
  END IF;
  IF v_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'alias "%" must live in the target project''s workspace', NEW.alias;
  END IF;
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'alias "%" targets a project with no canonical slug', NEW.alias;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_project_alias_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF (NEW.slug IS NULL AND OLD.slug IS NOT NULL)
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('project-alias:' || NEW.id::text));
  END IF;
  IF NEW.slug IS NULL AND OLD.slug IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.project_slug_aliases a WHERE a.project_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'cannot clear the slug of project % while aliases reference it', NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- Owner or workspace move: aliases follow the project. The cascade UPDATE
-- re-fires the alias-side triggers per row, so the aliases are re-validated
-- under the NEW namespace — any collision aborts the move.
CREATE OR REPLACE FUNCTION public.cascade_alias_owner_on_project_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    UPDATE public.project_slug_aliases
    SET user_id = NEW.user_id, workspace_id = NEW.workspace_id
    WHERE project_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- The pin resolves in ONE namespace: the thread's workspace (§1b).
DROP FUNCTION public.compute_thread_key_pin(uuid, text);
CREATE FUNCTION public.compute_thread_key_pin(
  p_workspace_id uuid, p_key text, OUT o_project text, OUT o_type text, OUT o_id text
)
RETURNS record
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  segs text[];
  v_canonical text;
BEGIN
  o_project := NULL; o_type := NULL; o_id := NULL;
  segs := string_to_array(p_key, ':');
  IF array_length(segs, 1) IS NULL OR array_length(segs, 1) < 2
     OR segs[1] = '' OR segs[2] = '' THEN
    RETURN;
  END IF;

  v_canonical := NULL;
  IF array_length(segs, 1) >= 3 AND segs[3] <> '' THEN
    SELECT p.slug INTO v_canonical
    FROM public.projects p
    WHERE p.workspace_id = p_workspace_id AND p.slug = segs[1];
    IF v_canonical IS NULL THEN
      SELECT p.slug INTO v_canonical
      FROM public.project_slug_aliases a
      JOIN public.projects p ON p.id = a.project_id
      WHERE a.workspace_id = p_workspace_id AND a.alias = segs[1];
    END IF;
  END IF;

  IF v_canonical IS NOT NULL THEN
    o_project := v_canonical;
    o_type := segs[2];
    o_id := array_to_string(segs[3:], ':');
  ELSE
    o_project := NULL;
    o_type := segs[1];
    o_id := array_to_string(segs[2:], ':');
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pin_thread_key_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pin record;
BEGIN
  -- Unconditional: the DB is the ONLY pinning authority, and the namespace
  -- is the thread's workspace.
  SELECT * INTO pin FROM public.compute_thread_key_pin(NEW.workspace_id, NEW.thread_key);
  NEW.key_project := pin.o_project;
  NEW.key_type := pin.o_type;
  NEW.key_id := pin.o_id;
  RETURN NEW;
END;
$$;

-- Re-pin every thread under its workspace's namespace (immutability trigger
-- is disabled from step 2 for exactly this; re-enabled below). Reported,
-- not silent.
DO $$
DECLARE v_changed bigint;
BEGIN
  WITH repinned AS (
    UPDATE public.inbox_threads t
       SET key_project = pin.o_project, key_type = pin.o_type, key_id = pin.o_id
      FROM (
        SELECT t2.id, p.o_project, p.o_type, p.o_id
        FROM public.inbox_threads t2
        CROSS JOIN LATERAL public.compute_thread_key_pin(t2.workspace_id, t2.thread_key) p
      ) pin
     WHERE pin.id = t.id
       AND (t.key_project IS DISTINCT FROM pin.o_project
            OR t.key_type IS DISTINCT FROM pin.o_type
            OR t.key_id IS DISTINCT FROM pin.o_id)
    RETURNING t.id
  )
  SELECT count(*) INTO v_changed FROM repinned;
  RAISE NOTICE 'cutover: % thread pin(s) changed under workspace namespaces', v_changed;
END $$;
ALTER TABLE public.inbox_threads ENABLE TRIGGER enforce_thread_key_immutability;

-- ── 6. Constraints ─────────────────────────────────────────────────────────
-- Identities: the workspace-local slug is the boundary alias (§1c), and the
-- (id, workspace_id) pair is what the participant FK points at.
ALTER TABLE public.agent_identities
  ADD CONSTRAINT agent_identities_id_workspace_key UNIQUE (id, workspace_id);
CREATE UNIQUE INDEX agent_identities_workspace_agent_key
  ON public.agent_identities (workspace_id, agent_id) WHERE workspace_id IS NOT NULL;

ALTER TABLE public.inbox_threads
  DROP CONSTRAINT inbox_threads_unique_key,
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT inbox_threads_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT inbox_threads_workspace_key UNIQUE (workspace_id, thread_key),
  ADD CONSTRAINT inbox_threads_id_workspace_key UNIQUE (id, workspace_id),
  ALTER COLUMN created_by_kind SET NOT NULL,
  -- Creation always has an event: exactly one of the pair, or the system (§3).
  ADD CONSTRAINT inbox_threads_creator_principal CHECK (
    (created_by_kind = 'sb' AND created_by_sb_id IS NOT NULL AND created_by_user_id IS NULL)
    OR (created_by_kind = 'user' AND created_by_user_id IS NOT NULL AND created_by_sb_id IS NULL)
    OR (created_by_kind = 'system' AND created_by_sb_id IS NULL AND created_by_user_id IS NULL)
  ),
  -- Closure may not have happened: no closed_at means no closer at all (§3).
  -- `IS TRUE`: a NULL kind on a closed thread must fail, not pass as
  -- unknown — a closure without a principal is exactly what §3 forbids
  -- (Lumen, #616 P2).
  ADD CONSTRAINT inbox_threads_closer_principal CHECK ((
    (closed_at IS NULL AND closed_by_kind IS NULL AND closed_by_sb_id IS NULL AND closed_by_user_id IS NULL)
    OR (closed_at IS NOT NULL AND closed_by_kind IS NOT NULL AND (
      (closed_by_kind = 'sb' AND closed_by_sb_id IS NOT NULL AND closed_by_user_id IS NULL)
      OR (closed_by_kind = 'user' AND closed_by_user_id IS NOT NULL AND closed_by_sb_id IS NULL)
      OR (closed_by_kind = 'system' AND closed_by_sb_id IS NULL AND closed_by_user_id IS NULL)
    ))
  ) IS TRUE);
CREATE INDEX idx_inbox_threads_workspace_status ON public.inbox_threads (workspace_id, status);

ALTER TABLE public.inbox_thread_participants
  DROP CONSTRAINT inbox_thread_participants_pkey,
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN principal_key SET NOT NULL,
  ADD CONSTRAINT inbox_thread_participants_principal CHECK ((sb_id IS NOT NULL) <> (user_id IS NOT NULL)),
  ADD CONSTRAINT inbox_thread_participants_human_no_session CHECK (user_id IS NULL OR session_id IS NULL),
  ADD CONSTRAINT inbox_thread_participants_principal_key UNIQUE (thread_id, principal_key),
  -- Participant-workspace equality by construction (§1c): the thread and the
  -- SB are each referenced together with the workspace, so moving either out
  -- of the workspace fails against its live participant rows.
  ADD CONSTRAINT inbox_thread_participants_thread_workspace_fkey
    FOREIGN KEY (thread_id, workspace_id) REFERENCES public.inbox_threads (id, workspace_id) ON DELETE CASCADE,
  -- NO ACTION, checked at commit: deleting an identity on its own still
  -- fails against its live participant rows, while deleting a whole
  -- workspace — which cascades to identities AND (through threads) to these
  -- rows — completes, because by commit nothing dangles. RESTRICT checked
  -- the identity edge before the thread cascade had run (Lumen, #616 P2).
  ADD CONSTRAINT inbox_thread_participants_sb_workspace_fkey
    FOREIGN KEY (sb_id, workspace_id) REFERENCES public.agent_identities (id, workspace_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT inbox_thread_participants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
CREATE INDEX idx_inbox_thread_participants_sb
  ON public.inbox_thread_participants (sb_id, thread_id) WHERE sb_id IS NOT NULL;
CREATE INDEX idx_inbox_thread_participants_user
  ON public.inbox_thread_participants (user_id, thread_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_inbox_thread_participants_sb_session
  ON public.inbox_thread_participants (sb_id, session_id) WHERE session_id IS NOT NULL;

ALTER TABLE public.inbox_thread_messages
  ALTER COLUMN sender_kind SET NOT NULL,
  -- A system message borrows nobody's identity (§3): both ids null, kind says system.
  ADD CONSTRAINT inbox_thread_messages_sender_principal CHECK (
    (sender_kind = 'sb' AND sender_sb_id IS NOT NULL AND sender_user_id IS NULL)
    OR (sender_kind = 'user' AND sender_user_id IS NOT NULL AND sender_sb_id IS NULL)
    OR (sender_kind = 'system' AND sender_sb_id IS NULL AND sender_user_id IS NULL)
  ),
  ADD CONSTRAINT inbox_thread_messages_slug_only_for_sb CHECK (sender_kind = 'sb' OR sender_agent_id IS NULL);
CREATE INDEX idx_inbox_thread_messages_sender_sb
  ON public.inbox_thread_messages (sender_sb_id) WHERE sender_sb_id IS NOT NULL;

ALTER TABLE public.inbox_thread_read_status
  DROP CONSTRAINT inbox_thread_read_status_pkey,
  ALTER COLUMN principal_key SET NOT NULL,
  ADD CONSTRAINT inbox_thread_read_status_principal CHECK ((sb_id IS NOT NULL) <> (user_id IS NOT NULL)),
  ADD CONSTRAINT inbox_thread_read_status_principal_key UNIQUE (thread_id, principal_key),
  ADD CONSTRAINT inbox_thread_read_status_sb_id_fkey
    FOREIGN KEY (sb_id) REFERENCES public.agent_identities(id) ON DELETE CASCADE,
  ADD CONSTRAINT inbox_thread_read_status_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ── 7. SQL readers and writers ─────────────────────────────────────────────
-- Delivery-poll candidacy is per SB principal. Workspace scope is implicit:
-- a participant row carries (sb_id, workspace_id), and the composite FK says
-- that identity lives in exactly that workspace.
DROP FUNCTION public.get_unread_thread_candidates(uuid, text, uuid, int);
CREATE FUNCTION public.get_unread_thread_candidates(
  p_sb_id uuid,
  p_session_id uuid DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  thread_id uuid,
  latest_message_at timestamptz,
  total_candidates bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT p.thread_id, p.joined_at
    FROM public.inbox_thread_participants p
    WHERE p.sb_id = p_sb_id
      AND (p_session_id IS NULL OR p.session_id = p_session_id)
  ),
  latest AS (
    SELECT m.thread_id, max(m.created_at) AS latest_message_at
    FROM public.inbox_thread_messages m
    JOIN scoped s ON s.thread_id = m.thread_id
    WHERE m.message_type <> 'system'
    GROUP BY m.thread_id
  ),
  candidates AS (
    SELECT l.thread_id, l.latest_message_at
    FROM latest l
    JOIN scoped s ON s.thread_id = l.thread_id
    LEFT JOIN public.inbox_thread_read_status rs
      ON rs.thread_id = l.thread_id AND rs.sb_id = p_sb_id
    WHERE l.latest_message_at > COALESCE(rs.last_read_at, s.joined_at)
  )
  SELECT c.thread_id, c.latest_message_at,
         (SELECT count(*) FROM candidates) AS total_candidates
  FROM candidates c
  ORDER BY c.latest_message_at DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.get_unread_thread_candidates(uuid, uuid, int) IS
  'Delivery-poll thread candidacy for one SB principal: threads, open or closed, whose latest DELIVERABLE (non-system) message is newer than the SB''s read pointer (or join time). Closed is a work-state signal, not a delivery filter. Spec: inkmail-read-state §4; inkmail-thread-scope §2, §3.';

-- The read pointer, for either kind of principal, in the one read-state
-- table (§3: a second cursor for humans would recreate the drift).
DROP FUNCTION public.advance_thread_read_pointer(uuid, text, uuid);
CREATE FUNCTION public.advance_thread_read_pointer(
  p_thread_id uuid,
  p_sb_id uuid,
  p_user_id uuid,
  p_through_message_id uuid
) RETURNS timestamptz AS $$
DECLARE
  v_created_at timestamptz;
  v_result timestamptz;
BEGIN
  IF (p_sb_id IS NULL) = (p_user_id IS NULL) THEN
    RAISE EXCEPTION 'advance_thread_read_pointer: exactly one of p_sb_id, p_user_id must be set';
  END IF;

  SELECT created_at INTO v_created_at
  FROM public.inbox_thread_messages
  WHERE id = p_through_message_id AND thread_id = p_thread_id;

  IF v_created_at IS NULL THEN
    RAISE EXCEPTION 'advance_thread_read_pointer: message % not found in thread %',
      p_through_message_id, p_thread_id;
  END IF;

  INSERT INTO public.inbox_thread_read_status (thread_id, sb_id, user_id, last_read_at)
  VALUES (p_thread_id, p_sb_id, p_user_id, v_created_at)
  ON CONFLICT (thread_id, principal_key)
  DO UPDATE SET last_read_at = GREATEST(inbox_thread_read_status.last_read_at, EXCLUDED.last_read_at)
  RETURNING last_read_at INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- Routing holds: the thread is addressed by (id, workspace). The per-agent
-- recovery map stays keyed by slug inside metadata; that is routing state,
-- not authorship.
DROP FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb);
CREATE FUNCTION public.stamp_routing_hold(
  p_thread_id uuid,
  p_workspace_id uuid,
  p_agent_id text,
  p_attempt_started timestamptz,
  p_hold jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE inbox_threads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('routingHold', p_hold)
   WHERE id = p_thread_id
     AND workspace_id = p_workspace_id
     AND (
       metadata -> 'routingRecovery' ->> p_agent_id IS NULL
       OR (metadata -> 'routingRecovery' ->> p_agent_id)::timestamptz < p_attempt_started
     );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

DROP FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz);
CREATE FUNCTION public.clear_routing_hold(
  p_thread_id uuid,
  p_workspace_id uuid,
  p_agent_id text,
  p_routed_since timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  did_clear boolean;
  found boolean;
BEGIN
  SELECT
    true,
    (metadata -> 'routingHold' ->> 'agentId' = p_agent_id
     AND COALESCE(
           (metadata -> 'routingHold' ->> 'attemptStartedAt')::timestamptz,
           (metadata -> 'routingHold' ->> 'heldAt')::timestamptz
         ) <= p_routed_since)
    INTO found, did_clear
    FROM inbox_threads
   WHERE id = p_thread_id AND workspace_id = p_workspace_id
     FOR UPDATE;

  IF NOT COALESCE(found, false) THEN
    RETURN 0;
  END IF;

  UPDATE inbox_threads
     SET metadata =
           (CASE WHEN COALESCE(did_clear, false)
                 THEN metadata - 'routingHold'
                 ELSE COALESCE(metadata, '{}'::jsonb)
            END)
           || jsonb_build_object(
                'routingRecovery',
                COALESCE(metadata -> 'routingRecovery', '{}'::jsonb)
                  || jsonb_build_object(
                       p_agent_id,
                       GREATEST(
                         p_routed_since,
                         COALESCE(
                           (metadata -> 'routingRecovery' ->> p_agent_id)::timestamptz,
                           '-infinity'::timestamptz
                         )
                       )
                     )
              )
   WHERE id = p_thread_id
     AND workspace_id = p_workspace_id;

  RETURN CASE WHEN COALESCE(did_clear, false) THEN 1 ELSE 0 END;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_routing_hold(uuid, uuid, text, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_routing_hold(uuid, uuid, text, timestamptz) TO service_role;

-- reopen_inbox_thread (PR #615): the actor is a principal now, and the
-- audit event says system by kind. Same contract: one transaction; true =
-- reopened by this call; false = the row was not closed, nothing written.
DROP FUNCTION IF EXISTS public.reopen_inbox_thread(uuid, text, text);
CREATE FUNCTION public.reopen_inbox_thread(
  p_thread_id uuid,
  p_actor_sb_id uuid,
  p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_updated integer;
  v_label text;
BEGIN
  IF (p_actor_sb_id IS NULL) = (p_actor_user_id IS NULL) THEN
    RAISE EXCEPTION 'reopen_inbox_thread: exactly one of p_actor_sb_id, p_actor_user_id must be set';
  END IF;

  UPDATE public.inbox_threads
     SET status = 'open',
         closed_at = NULL,
         closed_by_kind = NULL,
         closed_by_sb_id = NULL,
         closed_by_user_id = NULL,
         updated_at = now()
   WHERE id = p_thread_id
     AND status = 'closed';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  IF p_actor_sb_id IS NOT NULL THEN
    SELECT ai.agent_id INTO v_label FROM public.agent_identities ai WHERE ai.id = p_actor_sb_id;
  END IF;

  INSERT INTO public.inbox_thread_messages (thread_id, sender_kind, content, message_type, metadata)
  VALUES (
    p_thread_id,
    'system',
    CASE WHEN p_actor_sb_id IS NOT NULL
         THEN 'Thread reopened by ' || COALESCE(v_label, p_actor_sb_id::text)
         ELSE 'Thread reopened by a workspace member' END,
    'system',
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'thread_reopened',
      'reopenedBySbId', p_actor_sb_id,
      'reopenedByUserId', p_actor_user_id
    ))
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_inbox_thread(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_inbox_thread(uuid, uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_inbox_thread(uuid, uuid, uuid) TO service_role;

-- claim_turn_epoch: the closed-thread regrant refusal addressed the thread
-- by (user_id, thread_key). The canonical key is (workspace_id, thread_key)
-- now, so the regrant payload names the workspace and the check reads that
-- one row; a payload without one is refused. Everything else in the
-- function is unchanged (verbatim from 20260902052443).
DROP FUNCTION IF EXISTS public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text);

CREATE FUNCTION public.claim_turn_epoch(
  p_session_id uuid,
  p_set_running boolean DEFAULT false,
  p_not_stopped_after timestamptz DEFAULT NULL,
  p_studio_id uuid DEFAULT NULL,
  p_regrant jsonb DEFAULT NULL,
  p_attempt text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_session record;
  v_session_user uuid;
  v_studio record;
  v_path text;
  v_pathless boolean;
  v_locked_path text;
  v_new text := gen_random_uuid()::text;
  v_epoch text;
  v_regrant boolean := false;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT user_id, cli_turn_fenced_attempts
    INTO v_session
    FROM public.sessions WHERE id = p_session_id;
  IF v_session.user_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;
  v_session_user := v_session.user_id;

  IF p_attempt IS NOT NULL AND v_session.cli_turn_fenced_attempts ? p_attempt THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF p_studio_id IS NOT NULL THEN
    SELECT user_id, public.normalize_worktree_path(worktree_path)
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;
    IF v_studio.user_id IS DISTINCT FROM v_session_user THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    v_path := v_studio.normalize_worktree_path;
    v_pathless := (v_path IS NULL OR v_path = '');

    PERFORM pg_advisory_xact_lock(hashtext(
      CASE WHEN v_pathless
        THEN 'studio-pathless:' || v_session_user::text
        ELSE 'studio-path:' || v_session_user::text || ':' || v_path
      END
    ));

    SELECT id, user_id, lease, status, expires_at, worktree_path
      INTO v_studio
      FROM public.studios
      WHERE id = p_studio_id
      FOR UPDATE;

    IF v_studio.id IS NULL OR v_studio.user_id IS DISTINCT FROM v_session_user THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    v_locked_path := public.normalize_worktree_path(v_studio.worktree_path);
    IF v_pathless THEN
      IF NOT (v_locked_path IS NULL OR v_locked_path = '') THEN
        RETURN jsonb_build_object('outcome', 'lease-lost');
      END IF;
    ELSIF v_locked_path IS DISTINCT FROM v_path THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;

    IF v_studio.lease IS NULL THEN
      IF p_regrant IS NULL
         OR v_studio.status NOT IN ('active', 'idle')
         OR (v_studio.expires_at IS NOT NULL AND v_studio.expires_at <= now())
         -- The thread a regrant is for is one row: (workspace_id, thread_key)
         -- is the canonical key now, and workspace-local keys repeat across
         -- workspaces on purpose. A regrant that does not say which workspace
         -- cannot be checked, so it is refused (fail closed) rather than
         -- matched against every namesake the owner can see. (Lumen, #616 P1.)
         OR (p_regrant->>'workspaceId') IS NULL
         OR EXISTS (
           SELECT 1 FROM public.inbox_threads t
           WHERE t.workspace_id = (p_regrant->>'workspaceId')::uuid
             AND t.thread_key = p_regrant->>'threadKey'
             AND t.status = 'closed'
         )
         OR EXISTS (
           SELECT 1 FROM public.studios s
           WHERE s.id <> v_studio.id
             AND s.user_id = v_studio.user_id
             AND s.lease IS NOT NULL
             AND (
               CASE WHEN v_pathless
                 THEN COALESCE(public.normalize_worktree_path(s.worktree_path), '') = ''
                 ELSE public.normalize_worktree_path(s.worktree_path) = v_path
               END
             )
         ) THEN
        RETURN jsonb_build_object('outcome', 'lease-lost');
      END IF;
      v_regrant := true;
    ELSIF v_studio.lease->>'sessionId' IS DISTINCT FROM p_session_id::text
       OR COALESCE((v_studio.lease->>'quarantined')::boolean, false) THEN
      RETURN jsonb_build_object('outcome', 'lease-lost');
    END IF;
  END IF;

  UPDATE public.sessions
  SET turn_epoch = CASE
        WHEN p_attempt IS NOT NULL AND (cli_turn_attempt_claims ? p_attempt)
        THEN turn_epoch
        ELSE v_new
      END,
      lifecycle = CASE WHEN p_set_running THEN 'running' ELSE lifecycle END,
      cli_turn_at = CASE WHEN p_set_running THEN now() ELSE cli_turn_at END,
      studio_id = CASE WHEN v_regrant THEN p_studio_id ELSE studio_id END,
      cli_turn_attempt_claims = CASE
        WHEN p_attempt IS NULL OR (cli_turn_attempt_claims ? p_attempt)
        THEN cli_turn_attempt_claims
        ELSE cli_turn_attempt_claims || jsonb_build_object(p_attempt, v_new)
      END
  WHERE id = p_session_id
    AND (
      -- The wall-clock tombstone applies ONLY to legacy attempt-less
      -- reclaims (round 24): CLI marker time vs DB now() is unordered
      -- under clock skew, and a fresh modern attempt falsely 'stopped'
      -- would run stale and retire its marker. Modern attempts are fully
      -- protected by the consume/replay/fence lifecycle — no clocks.
      p_attempt IS NOT NULL
      OR p_not_stopped_after IS NULL
      OR cli_turn_stopped_at IS NULL
      OR cli_turn_stopped_at < p_not_stopped_after
    )
    AND (
      p_attempt IS NULL
      OR NOT (cli_turn_fenced_attempts ? p_attempt)
    )
    AND (
      p_attempt IS NOT NULL
      OR p_not_stopped_after IS NULL
      OR cli_turn_missing_stop_at IS NULL
      OR cli_turn_missing_stop_at < p_not_stopped_after
    )
    AND (
      -- A REPLAY (attempt already recorded) is valid only while its epoch
      -- still owns a RUNNING row — never a resurrection, and the running-
      -- entry trigger never fires for it.
      p_attempt IS NULL
      OR NOT (cli_turn_attempt_claims ? p_attempt)
      OR (cli_turn_attempt_claims ->> p_attempt = turn_epoch AND lifecycle = 'running')
    )
  RETURNING turn_epoch INTO v_epoch;

  IF v_epoch IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stopped');
  END IF;

  IF v_regrant THEN
    UPDATE public.studios
    SET lease = p_regrant || jsonb_build_object(
          'acquiredAt', v_now,
          'heartbeatAt', v_now,
          'turnEpoch', v_epoch
        )
    WHERE id = p_studio_id;
  END IF;

  UPDATE public.studios
  SET lease = lease || jsonb_build_object(
        'heartbeatAt', v_now,
        'turnEpoch', v_epoch
      )
  WHERE user_id = v_session_user
    AND lease IS NOT NULL
    AND lease->>'sessionId' = p_session_id::text
    AND COALESCE((lease->>'quarantined')::boolean, false) = false;

  RETURN jsonb_build_object('outcome', 'claimed', 'epoch', v_epoch, 'regranted', v_regrant);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_turn_epoch(uuid, boolean, timestamptz, uuid, jsonb, text) FROM anon, authenticated;


-- ── 8. Legacy columns ──────────────────────────────────────────────────────
ALTER TABLE public.inbox_threads
  DROP COLUMN user_id,
  DROP COLUMN created_by_agent_id,
  DROP COLUMN closed_by_agent_id;
ALTER TABLE public.inbox_threads ENABLE TRIGGER update_inbox_threads_updated_at;

ALTER TABLE public.inbox_thread_participants DROP COLUMN agent_id;
ALTER TABLE public.inbox_thread_read_status DROP COLUMN agent_id;

-- ── 9. Personal-workspace provisioning lives in the database (§1) ──────────
-- There are several direct users insert paths, and the create-then-add-member
-- helper is not atomic; the trigger is.
CREATE OR REPLACE FUNCTION public.provision_personal_workspace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  SELECT w.id INTO v_workspace_id
  FROM public.workspaces w
  WHERE w.user_id = NEW.id AND w.type = 'personal' AND w.slug = 'personal' AND w.archived_at IS NULL
  LIMIT 1;
  IF v_workspace_id IS NULL THEN
    INSERT INTO public.workspaces (user_id, name, slug, type)
    VALUES (NEW.id, 'Personal', 'personal', 'personal')
    RETURNING id INTO v_workspace_id;
  END IF;
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provision_personal_workspace
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.provision_personal_workspace();

-- ── 10. Staging and helpers ────────────────────────────────────────────────
DROP FUNCTION public.inkmail_cutover_preflight();
DROP FUNCTION public.inkmail_cutover_suggest_principals();
DROP FUNCTION public.inkmail_cutover_suggest_threads();
DROP FUNCTION public.inkmail_cutover_resolve_principal(text, uuid, text, uuid, uuid);
DROP FUNCTION public.inkmail_cutover_effective_message_attestations();
DROP FUNCTION public.inkmail_cutover_personal_workspace(uuid);
DROP TABLE public.inkmail_cutover_principal_attestations;
DROP TABLE public.inkmail_cutover_thread_attestations;

COMMENT ON COLUMN public.inbox_threads.workspace_id IS
  'The workspace this thread belongs to; (workspace_id, thread_key) is unique. Spec inkmail-thread-scope §1.';
COMMENT ON COLUMN public.inbox_thread_messages.sender_kind IS
  'sb | user | system. A system message borrows nobody''s identity: both sender ids are null. Spec inkmail-thread-scope §3.';
COMMENT ON COLUMN public.inbox_thread_messages.sender_agent_id IS
  'Display slug for SB-authored rows only; never a delivery key. Spec inkmail-thread-scope §3.';
COMMENT ON COLUMN public.inbox_thread_participants.principal_key IS
  'sb:<uuid> | user:<uuid> — the one conflict target for both kinds of participant. Spec inkmail-thread-scope §3.';
