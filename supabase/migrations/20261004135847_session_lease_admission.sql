-- Studio leases join turn admission, slice C1 (ink://specs/live-agent-surfaces
-- v29 R3; pr:701 d51cf192, accepted in f18c275d).
--
-- DARK, like slices A and A2: nothing calls this, and it refuses with
-- mode_mismatch unless runtime_admission_mode is 'conditional' at the
-- caller's protocol. claim_turn_epoch, the lease service and every live
-- caller are unchanged; in legacy mode claim stays the only turn authority.
--
-- admit_leased_turn admits a turn exactly as admit_turn does, for a session
-- that holds the named studio's lease, and moves the session's leases to the
-- new turn in the same transaction: the lease restamp, the session pointer,
-- the command claim and the generation commit together or not at all.
--
-- Lock order. Leases come before the session, in claim_turn_epoch's order,
-- extended from one studio to a set:
--   1. one path advisory lock, the named studio's (claim's exact key), taken
--      before any row lock and the only advisory lock this function takes;
--   2. every studio row in the candidate set (the named studio and the
--      session's other live leases), in one statement, in ascending id;
--   3. the sessions row, then admit_turn's own admission, history and
--      command locks.
-- No studio lock is taken after the sessions row: the restamp touches only
-- rows already locked in step 2. A lease the session gains after the
-- candidate set was read is outside this admission and is not restamped; it
-- keeps the turnEpoch it was granted with.
--
-- A refusal from admit_turn is returned unchanged. A stale_expectation that
-- names the caller's own epoch is a refusal, never a replay success: it is
-- returned before generation state, command identity and holds are read, so
-- it carries no permission to dispatch.
--
-- Not here (each its own gate): lease regrant, which needs parity with
-- claim_turn_epoch; reconciling a pendingRelease, which this keeps byte for
-- byte and never resolves; claim_turn_epoch refusing in conditional mode; and
-- routing every leased session through this function rather than admit_turn.

CREATE FUNCTION public.admit_leased_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text,
  p_expected_prior_epoch text,
  p_epoch text,
  p_command_uuid uuid,
  p_studio_id uuid,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_refusal jsonb;
  v_user uuid;
  v_studio_user uuid;
  v_path text;
  v_pathless boolean;
  v_candidates uuid[];
  v_locked uuid[] := '{}';
  v_row record;
  v_named record;
  v_named_path text;
  v_admit jsonb;
  v_restamped integer;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_studio_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'studio');
  END IF;

  -- Unlocked reads, to choose the locks. None of them is authority: each is
  -- checked again under the locks below.
  SELECT user_id INTO v_user FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  SELECT user_id, public.normalize_worktree_path(worktree_path)
    INTO v_studio_user, v_path
    FROM public.studios WHERE id = p_studio_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lease_lost');
  END IF;
  IF v_studio_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  v_pathless := (v_path IS NULL OR v_path = '');
  SELECT array_agg(c.id ORDER BY c.id) INTO v_candidates
    FROM (
      SELECT p_studio_id AS id
      UNION
      SELECT s.id FROM public.studios s
       WHERE s.user_id = v_user
         AND s.lease->>'sessionId' = p_session_id::text
         AND COALESCE((s.lease->>'quarantined')::boolean, false) = false
    ) c;

  -- 1. The named studio's path lock, claim's exact key.
  PERFORM pg_advisory_xact_lock(hashtext(
    CASE WHEN v_pathless
      THEN 'studio-pathless:' || v_user::text
      ELSE 'studio-path:' || v_user::text || ':' || v_path
    END
  ));

  -- 2. Every candidate row, one statement, ascending id.
  FOR v_row IN
    SELECT id FROM public.studios WHERE id = ANY(v_candidates) ORDER BY id FOR UPDATE
  LOOP
    v_locked := v_locked || v_row.id;
  END LOOP;

  -- The named lease, under its lock: same tenant, same path, held by this
  -- session, not quarantined.
  SELECT user_id, lease, worktree_path INTO v_named
    FROM public.studios WHERE id = p_studio_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'lease_lost');
  END IF;
  IF v_named.user_id IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;
  v_named_path := public.normalize_worktree_path(v_named.worktree_path);
  IF v_pathless THEN
    IF NOT (v_named_path IS NULL OR v_named_path = '') THEN
      RETURN jsonb_build_object('outcome', 'lease_lost');
    END IF;
  ELSIF v_named_path IS DISTINCT FROM v_path THEN
    RETURN jsonb_build_object('outcome', 'lease_lost');
  END IF;
  IF v_named.lease IS NULL
     OR v_named.lease->>'sessionId' IS DISTINCT FROM p_session_id::text
     OR COALESCE((v_named.lease->>'quarantined')::boolean, false) THEN
    RETURN jsonb_build_object('outcome', 'lease_lost');
  END IF;

  -- 3. The sessions row, and its tenant, which keyed every lock above.
  SELECT user_id INTO v_studio_user FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  IF v_studio_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  -- The reviewed admission, unchanged. Its refusal is the answer.
  v_admit := public.admit_turn(
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id,
    p_expected_prior_epoch, p_epoch, p_command_uuid, p_protocol
  );
  IF v_admit->>'outcome' IS DISTINCT FROM 'admitted' THEN
    RETURN v_admit;
  END IF;

  -- Only the rows locked above, and only while each still holds this
  -- tenant's live lease for this session. The merge keeps pendingRelease and
  -- threadKeys as they are.
  UPDATE public.studios
     SET lease = lease || jsonb_build_object('heartbeatAt', v_now, 'turnEpoch', p_epoch)
   WHERE id = ANY(v_locked)
     AND user_id = v_user
     AND lease->>'sessionId' = p_session_id::text
     AND COALESCE((lease->>'quarantined')::boolean, false) = false;
  GET DIAGNOSTICS v_restamped = ROW_COUNT;
  RETURN v_admit || jsonb_build_object('restamped', v_restamped);
END;
$$;

REVOKE ALL ON FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer) TO service_role;
