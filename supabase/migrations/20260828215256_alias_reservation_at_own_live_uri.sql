-- Reserve-then-move: close the rename capture window (PR #548 round 1, Lumen).
--
-- The rename CAS and the alias insert are separate PostgREST transactions.
-- With insert-after-update, the old URI was released before it was aliased:
-- rename A→B commits, artifact 2 is created at A, the alias insert then fails,
-- and canonical-first resolution of A silently retargets to the squatter.
--
-- The fix reverses the order — the application inserts the alias for the old
-- URI BEFORE the CAS releases it. For that to be legal, the alias trigger's
-- live-URI collision check gains exactly one exception: an alias may sit at
-- its OWN target's current uri (a "reservation"). Every other combination
-- stays rejected.
--
-- Why every intermediate state is now safe:
--   * reservation in place, URI still live: canonical resolution wins (the
--     resolver tries artifacts.uri first), and both capture paths are closed —
--     creating at A violates artifacts_uri_key while A is live, and becomes
--     "collides with another artifact's alias" the instant it is not.
--   * CAS lost or process crashed after reserving: the leftover reservation
--     points at the artifact that ALREADY owns the URI — resolution is
--     unchanged and a retried rename treats it as its own reservation.
--   * alias-write failure now aborts the rename (it happens first), instead
--     of succeeding with a dead old URI.

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
  -- A reservation at the target's own live URI is the rename's atomicity
  -- primitive; an alias at any OTHER artifact's live URI is still a shadow.
  IF EXISTS (
    SELECT 1 FROM public.artifacts a
    WHERE a.uri = NEW.alias_uri AND a.id <> NEW.artifact_id
  ) THEN
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
