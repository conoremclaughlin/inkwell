-- Artifact URI aliases: a rename leaves the old URI resolving forever.
--
-- The Library derives folders from URI namespaces (ink://specs/..., ink://ideas/...),
-- which makes "move" a URI rename — so old links must never break. This is the
-- project-slug-alias pattern (20260820183006) applied to artifact URIs: aliases
-- are globally unique (mirroring artifacts_uri_key UNIQUE (uri)), owner-bound to
-- their target, and namespace-enforced in both directions under one advisory-lock
-- family so the two tables serialize on the contested name.

-- 1) Alias table -------------------------------------------------------------
CREATE TABLE public.artifact_uri_aliases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  alias_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_uri)
);

CREATE INDEX idx_artifact_uri_aliases_artifact
  ON public.artifact_uri_aliases (artifact_id);

ALTER TABLE public.artifact_uri_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY artifact_uri_aliases_service ON public.artifact_uri_aliases
  FOR ALL USING (true);

-- 2) Alias integrity ----------------------------------------------------------
-- An alias must not shadow a live URI, must point at an artifact its owner
-- actually owns (alias-target-integrity lesson from 20260820184719), and
-- inherits the target's workspace so scope filters see consistent rows.
CREATE OR REPLACE FUNCTION public.enforce_artifact_alias_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_target_user uuid;
  v_target_workspace uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('artifact-uri:' || NEW.alias_uri));
  IF EXISTS (SELECT 1 FROM public.artifacts a WHERE a.uri = NEW.alias_uri) THEN
    RAISE EXCEPTION 'alias "%" collides with a live artifact URI', NEW.alias_uri;
  END IF;
  SELECT a.user_id, a.workspace_id INTO v_target_user, v_target_workspace
  FROM public.artifacts a WHERE a.id = NEW.artifact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alias target artifact % does not exist', NEW.artifact_id;
  END IF;
  IF v_target_user <> NEW.user_id THEN
    RAISE EXCEPTION 'alias owner does not match the target artifact''s owner';
  END IF;
  NEW.workspace_id := v_target_workspace;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_artifact_alias_integrity
  BEFORE INSERT OR UPDATE ON public.artifact_uri_aliases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_artifact_alias_integrity();

-- 3) URIs must not shadow aliases ---------------------------------------------
-- Excludes aliases pointing at the same artifact, so renaming an artifact back
-- to one of its own former URIs stays legal (the application deletes the
-- now-redundant alias in the same flow).
CREATE OR REPLACE FUNCTION public.enforce_artifact_uri_not_alias()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('artifact-uri:' || NEW.uri));
  IF EXISTS (
    SELECT 1 FROM public.artifact_uri_aliases al
    WHERE al.alias_uri = NEW.uri AND al.artifact_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'artifact URI "%" collides with another artifact''s alias', NEW.uri;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enforce_artifact_uri_not_alias
  BEFORE INSERT OR UPDATE OF uri ON public.artifacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_artifact_uri_not_alias();
