-- Admission authority seal (ink://specs/live-agent-surfaces; pr:701 dcf07675,
-- boundary 5aecb7d3, accepted by Lumen in d4050d8e and fe0a632f). A required
-- pre-activation slice. DARK, like the slices it seals.
--
-- D1 (20261005021135) sealed the projector: the invocation index and the
-- journal change only through their definers. Everything those definers trust
-- stayed writable by service_role: tenures, turn generations, creation
-- origins, the command tables, the mode row, and the owner and turn pointers
-- on sessions. The holder also proved itself with the stored hash, so a read
-- of that column was a working credential. This migration closes both.
--
-- What it guarantees, for an admission lineage (a session with a creation
-- origin, an owner tenure or a journal): nothing running as service_role can
-- mint, alter or erase holder authority, turn records, creation evidence or
-- command state except through the reviewed RPCs, and a leaked stored hash
-- authorizes nothing. Legacy sessions keep today's behavior.
--
-- What it does not claim: arbitrary writes to studios are not shown safe here
-- (a studio lease is not admission authority; admission still requires a
-- held tenure). A database administrator and migrations are trusted.
--
-- The pieces:
--   1. ink_admission_writer owns every admission table. service_role keeps
--      SELECT; anon and authenticated keep nothing. The mode row stays
--      postgres's, and only an operator (psql or a migration) changes it.
--   2. Every function that writes those tables runs as the writer, with an
--      empty search_path and schema-qualified bodies, and is otherwise
--      unchanged. The receipt helper moves into the private schema.
--   3. A guard on sessions refuses a change to owner_tenure_id or turn_epoch
--      on an admission lineage unless the writer makes it, and refuses a new
--      row that arrives with an owner. It is an AFTER trigger, so it judges
--      the final row after every BEFORE trigger, and an invoker, so
--      current_user is the real caller.
--   4. Holder RPCs take the raw capability and hash it here. The stored hash
--      is a digest of a 256-bit secret and is no longer presented.
--   5. Deleting a session, workspace or user that protected evidence still
--      references is refused (ON DELETE RESTRICT), where it used to cascade
--      the evidence away. Cleanup is an ordered administrator delete, or the
--      fixture harness's TRUNCATE.
--
-- Measured on PG 15.8 while designing this (rolled-back probes, 5aecb7d3): a
-- BEFORE row trigger fired by a referential action sees the child table's
-- owner as current_user, an AFTER row trigger sees the outer statement's
-- role. So no BEFORE trigger here exempts the writer, and the sessions guard
-- keys only on authority columns, which no referential action changes.

GRANT CREATE ON SCHEMA public TO ink_admission_writer;
GRANT CREATE ON SCHEMA ink_admission TO ink_admission_writer;

-- ── The capability ──────────────────────────────────────────────────────────
-- The same digest TypeScript's tenureCapabilityHash produced, now computed
-- here from the secret itself. NULL in, NULL out, so a missing capability
-- matches no tenure.
CREATE FUNCTION ink_admission.capability_hash(p_capability text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT 'sha256:' || encode(sha256(convert_to(p_capability, 'UTF8')), 'hex')
$$;

-- ── The receipt helper goes private ─────────────────────────────────────────
ALTER FUNCTION public.session_command_record_receipts(uuid, integer, text, text, jsonb)
  SET SCHEMA ink_admission;
ALTER FUNCTION ink_admission.session_command_record_receipts(uuid, integer, text, text, jsonb)
  SET search_path = '';

-- ── Holder RPCs: raw capability, run as the writer ──────────────────────────
-- A parameter cannot be renamed in place, so each is dropped and recreated
-- under the same argument types; its grants are restored below. Bodies are
-- the latest definitions with p_capability_hash replaced by the digest of
-- p_capability, and nothing else (admit_turn also loses a set_config that
-- nothing read).
DROP FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer);
DROP FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer);
DROP FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer);
DROP FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer);
DROP FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer);
DROP FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer);
DROP FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer);
DROP FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer);

CREATE FUNCTION public.register_tenure(
  p_session_id uuid,
  p_expected jsonb,
  p_mode text,
  p_capability text,
  p_host jsonb,
  p_owner jsonb,
  p_endpoint jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_kind text := p_expected->>'kind';
  v_expected_tenure text := p_expected->>'tenureId';
  v_session record;
  v_prior record;
  v_unresolved integer;
  v_head jsonb;
  v_id uuid;
  v_journal jsonb;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;

  IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
     OR v_kind IS NULL OR v_kind NOT IN ('never_owned', 'released', 'reconciled')
     OR (v_kind = 'never_owned') <> (v_expected_tenure IS NULL)
     OR (v_expected_tenure IS NOT NULL
         AND v_expected_tenure !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'expected');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('server_hosted', 'interactive_wrapper', 'native_external') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'mode');
  END IF;
  -- Bounds length and alphabet; the entropy comes from mintTenureCapability.
  IF p_capability IS NULL OR p_capability !~ '^[A-Za-z0-9_-]{43,200}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'capability');
  END IF;
  IF jsonb_typeof(p_host) IS DISTINCT FROM 'object'
     OR length(COALESCE(p_host->>'instanceId', '')) NOT BETWEEN 1 AND 200
     OR (p_host->>'hostId' IS NOT NULL AND length(p_host->>'hostId') NOT BETWEEN 1 AND 200)
     OR (p_host->>'bootId' IS NOT NULL AND length(p_host->>'bootId') NOT BETWEEN 1 AND 200) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'host');
  END IF;
  IF p_owner IS NOT NULL AND (
       jsonb_typeof(p_owner) IS DISTINCT FROM 'object'
       OR NOT public.session_admission_valid_pid(p_owner->>'pid')
       OR length(COALESCE(p_owner->>'startIdentity', '')) NOT BETWEEN 1 AND 200
     ) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'owner');
  END IF;

  SELECT s.id, s.owner_tenure_id, s.turn_epoch INTO v_session
    FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;

  -- D1: a DB lineage needs its matching journal header, and never falls back.
  v_journal := public.session_journal_gate(p_session_id);
  IF v_journal ? 'refusal' THEN RETURN v_journal->'refusal'; END IF;

  IF v_session.owner_tenure_id IS NULL THEN
    -- Never owned only on positive evidence; anything else is unverified history.
    IF NOT EXISTS (SELECT 1 FROM public.session_admission_origins o WHERE o.session_id = p_session_id)
       OR v_session.turn_epoch IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.session_owner_tenures t WHERE t.session_id = p_session_id)
       OR EXISTS (SELECT 1 FROM public.session_turn_generations g WHERE g.session_id = p_session_id) THEN
      RETURN jsonb_build_object('outcome', 'unverified');
    END IF;
    IF v_kind <> 'never_owned' THEN
      RETURN jsonb_build_object('outcome', 'stale_expectation', 'state', 'never_owned');
    END IF;
  ELSE
    SELECT t.id, t.state INTO v_prior
      FROM public.session_owner_tenures t
     WHERE t.id = v_session.owner_tenure_id AND t.session_id = p_session_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'unverified');
    END IF;
    IF v_prior.state IN ('held', 'recovery_required') THEN
      RETURN jsonb_build_object('outcome', 'occupied', 'tenureId', v_prior.id, 'state', v_prior.state);
    END IF;
    IF v_kind = 'never_owned' OR v_kind IS DISTINCT FROM v_prior.state
       OR v_expected_tenure IS DISTINCT FROM v_prior.id::text THEN
      RETURN jsonb_build_object('outcome', 'stale_expectation', 'tenureId', v_prior.id, 'state', v_prior.state);
    END IF;
    -- Released or reconciled said so; the evidence is checked again here.
    SELECT COALESCE(sum(public.session_turn_unresolved_invocations(p_session_id, g.epoch, true)), 0)
      INTO v_unresolved
      FROM public.session_turn_generations g
     WHERE g.session_id = p_session_id
       -- D1: on a DB lineage, every tenure's spawns, not only the predecessor's.
       AND (g.tenure_id = v_prior.id OR (v_journal->>'journaled')::boolean);
    IF v_unresolved > 0 OR EXISTS (
      SELECT 1 FROM public.session_turn_generations g
       WHERE g.session_id = p_session_id AND g.state IN ('active', 'recovery_required')
    ) THEN
      RETURN jsonb_build_object('outcome', 'unresolved', 'tenureId', v_prior.id);
    END IF;
  END IF;

  -- D1: a held journal stops admission, continuation and release.
  IF v_journal->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'journal_held', 'reasonCode', v_journal->>'hold');
  END IF;
  v_head := public.session_dispatch_head(p_session_id);
  IF v_head->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'held', 'hold', v_head->>'hold', 'holdingCommand', v_head->>'holdingCommand'
    );
  END IF;

  INSERT INTO public.session_owner_tenures (
    session_id, mode, state, capability_hash, host_instance_id, host_boot_id, host_id,
    owner_pid, owner_start_identity, endpoint
  ) VALUES (
    p_session_id, p_mode, 'held', ink_admission.capability_hash(p_capability), p_host->>'instanceId', p_host->>'bootId',
    p_host->>'hostId', (p_owner->>'pid')::integer, p_owner->>'startIdentity', p_endpoint
  )
  RETURNING id INTO v_id;

  UPDATE public.sessions SET owner_tenure_id = v_id WHERE id = p_session_id;

  RETURN jsonb_build_object('outcome', 'registered', 'tenureId', v_id);
END;
$$;

CREATE FUNCTION public.admit_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_expected_prior_epoch text,
  p_epoch text,
  p_command_uuid uuid,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_session record;
  v_prior record;
  v_head jsonb;
  v_command record;
  v_claim jsonb;
  v_unresolved integer;
  v_journal jsonb;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_tenure_id IS NULL OR ink_admission.capability_hash(p_capability) IS NULL OR p_host_instance_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'holder');
  END IF;
  IF p_epoch IS NULL OR length(p_epoch) NOT BETWEEN 1 AND 200 OR p_command_uuid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'turn');
  END IF;

  SELECT s.id, s.turn_epoch INTO v_session
    FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;

  v_holder := public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;

  -- D1: a DB lineage needs its matching journal header, and never falls back.
  v_journal := public.session_journal_gate(p_session_id);
  IF v_journal ? 'refusal' THEN RETURN v_journal->'refusal'; END IF;

  IF v_session.turn_epoch IS DISTINCT FROM p_expected_prior_epoch THEN
    RETURN jsonb_build_object('outcome', 'stale_expectation', 'epoch', v_session.turn_epoch);
  END IF;
  IF v_session.turn_epoch IS NOT DISTINCT FROM p_epoch THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'turn');
  END IF;

  IF v_session.turn_epoch IS NOT NULL THEN
    SELECT g.state, g.tenure_id INTO v_prior
      FROM public.session_turn_generations g
     WHERE g.session_id = p_session_id AND g.epoch = v_session.turn_epoch;
    IF NOT FOUND THEN
      -- A turn the admission authority never recorded: unverified.
      RETURN jsonb_build_object('outcome', 'unverified', 'epoch', v_session.turn_epoch);
    END IF;
    IF v_prior.state = 'active' THEN
      RETURN jsonb_build_object('outcome', 'busy', 'epoch', v_session.turn_epoch);
    END IF;
    IF v_prior.state = 'recovery_required' THEN
      RETURN jsonb_build_object('outcome', 'unresolved', 'epoch', v_session.turn_epoch);
    END IF;
  END IF;

  -- Every turn the session has run, not only the last: a background spawn of
  -- an older turn can turn uncertain after later turns finished. The holder's
  -- own turns need their spawns bound or resolved with nothing uncertain;
  -- turns under any other tenure need them resolved.
  IF EXISTS (
    SELECT 1 FROM public.session_turn_generations g
     WHERE g.session_id = p_session_id AND g.state = 'recovery_required'
  ) THEN
    RETURN jsonb_build_object('outcome', 'unresolved', 'epoch', v_session.turn_epoch);
  END IF;
  SELECT COALESCE(sum(public.session_turn_unresolved_invocations(
           p_session_id, g.epoch, g.tenure_id IS DISTINCT FROM p_tenure_id)), 0)
    INTO v_unresolved
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id;
  IF v_unresolved > 0 THEN
    RETURN jsonb_build_object('outcome', 'unresolved', 'epoch', v_session.turn_epoch);
  END IF;

  -- D1: a held journal stops admission, continuation and release.
  IF v_journal->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'journal_held', 'reasonCode', v_journal->>'hold');
  END IF;
  v_head := public.session_dispatch_head(p_session_id);
  IF v_head->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'held', 'hold', v_head->>'hold', 'holdingCommand', v_head->>'holdingCommand'
    );
  END IF;
  IF v_head->>'head' IS DISTINCT FROM p_command_uuid::text THEN
    RETURN jsonb_build_object('outcome', 'not_fifo_head', 'head', v_head->>'head');
  END IF;

  UPDATE public.sessions SET turn_epoch = p_epoch, lifecycle = 'running' WHERE id = p_session_id;
  INSERT INTO public.session_turn_generations (
    session_id, epoch, tenure_id, command_uuid, prior_epoch, state
  ) VALUES (
    p_session_id, p_epoch, p_tenure_id, p_command_uuid, v_session.turn_epoch, 'active'
  );

  -- The turn claims its command in the same transaction: started, under this
  -- epoch. It is never offered as the head again, and until terminal evidence
  -- lands it holds later work, so a lost dispatch write cannot run it twice.
  SELECT c.revision, c.state INTO v_command
    FROM public.session_commands c
   WHERE c.id = p_command_uuid AND c.session_id = p_session_id;
  v_claim := public.transition_command(
    p_command_uuid, v_command.revision, v_command.state, v_command.state, NULL, true, p_epoch,
    '[]'::jsonb, p_protocol
  );
  IF v_claim->>'outcome' IS DISTINCT FROM 'transitioned' THEN
    RAISE EXCEPTION 'admit_turn could not claim command %: %', p_command_uuid, v_claim->>'outcome';
  END IF;

  RETURN jsonb_build_object('outcome', 'admitted', 'epoch', p_epoch);
END;
$$;

-- admit_leased_turn passes the raw capability through to admit_turn. Its lease
-- restamp never changes worktree_path, so the studios update trigger returns
-- before the one query it writes without a schema.
CREATE FUNCTION public.admit_leased_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_expected_prior_epoch text,
  p_epoch text,
  p_command_uuid uuid,
  p_studio_id uuid,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

  -- The named row must be one this statement locked. A row deleted while we
  -- waited is skipped by the loop, and a later read could see a replacement
  -- inserted under the same id that this transaction never locked.
  IF NOT (p_studio_id = ANY(v_locked)) THEN
    RETURN jsonb_build_object('outcome', 'lease_lost');
  END IF;

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
    p_session_id, p_tenure_id, p_capability, p_host_instance_id,
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

CREATE FUNCTION public.finish_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_epoch text,
  p_evidence text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_session record;
  v_state text;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_epoch IS NULL OR p_evidence IS NULL OR p_evidence !~ '^[a-z0-9_.:-]{1,100}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'turn');
  END IF;

  SELECT s.id, s.turn_epoch INTO v_session
    FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  v_holder := public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;

  SELECT g.state INTO v_state
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.epoch = p_epoch AND g.tenure_id = p_tenure_id;
  IF v_session.turn_epoch IS DISTINCT FROM p_epoch OR v_state IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('outcome', 'stale', 'epoch', v_session.turn_epoch, 'state', v_state);
  END IF;

  UPDATE public.session_turn_generations
     SET state = 'finished', finished_at = now(), finish_evidence = p_evidence
   WHERE session_id = p_session_id AND epoch = p_epoch;

  RETURN jsonb_build_object('outcome', 'finished', 'epoch', p_epoch);
END;
$$;

CREATE FUNCTION public.release_tenure(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_evidence text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_unresolved integer;
  v_head jsonb;
  v_journal jsonb;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_evidence IS NULL
     OR p_evidence NOT IN ('wrapper_exit_tree_quiescent', 'controller_retired', 'native_wrapper_exit_tree_quiescent') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'evidence');
  END IF;

  PERFORM 1 FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  v_holder := public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;

  -- D1: a DB lineage needs its matching journal header, and never falls back.
  v_journal := public.session_journal_gate(p_session_id);
  IF v_journal ? 'refusal' THEN RETURN v_journal->'refusal'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_turn_generations g
     WHERE g.session_id = p_session_id AND g.state IN ('active', 'recovery_required')
  ) THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;
  SELECT COALESCE(sum(public.session_turn_unresolved_invocations(p_session_id, g.epoch, true)), 0)
    INTO v_unresolved
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id
     -- D1: on a DB lineage, every tenure's spawns, not only the releaser's.
     AND (g.tenure_id = p_tenure_id OR (v_journal->>'journaled')::boolean);
  IF v_unresolved > 0 THEN
    RETURN jsonb_build_object('outcome', 'unresolved', 'invocations', v_unresolved);
  END IF;
  -- D1: a held journal stops admission, continuation and release.
  IF v_journal->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'journal_held', 'reasonCode', v_journal->>'hold');
  END IF;
  v_head := public.session_dispatch_head(p_session_id);
  IF v_head->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'held', 'hold', v_head->>'hold', 'holdingCommand', v_head->>'holdingCommand'
    );
  END IF;

  UPDATE public.session_owner_tenures
     SET state = 'released', ended_at = now(), end_evidence = p_evidence, capability_hash = NULL
   WHERE id = p_tenure_id;

  RETURN jsonb_build_object('outcome', 'released', 'tenureId', p_tenure_id);
END;
$$;

CREATE FUNCTION public.record_invocation(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_epoch text,
  p_invocation_id text,
  p_kind text,
  p_detail jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_ref text;
  v_reason text;
  v_transcript text;
  v_start text;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
    'intent', 'process_binding', 'transcript_binding', 'parent_exited', 'group_empty',
    'tree_quiescent', 'not_spawned', 'unknown'
  ) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'kind');
  END IF;
  IF p_epoch IS NULL OR length(COALESCE(p_invocation_id, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'invocation');
  END IF;
  IF p_detail IS NOT NULL AND jsonb_typeof(p_detail) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
  END IF;
  v_ref := p_detail->>'evidenceRef';
  v_reason := p_detail->>'reasonCode';
  v_transcript := p_detail->>'providerTranscriptId';
  v_start := p_detail->>'startIdentity';
  IF p_kind = 'process_binding' THEN
    IF NOT public.session_admission_valid_pid(p_detail->>'pid')
       OR length(COALESCE(v_start, '')) NOT BETWEEN 1 AND 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
    END IF;
  ELSIF p_kind = 'transcript_binding' AND length(COALESCE(v_transcript, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
  ELSIF p_kind IN ('tree_quiescent', 'not_spawned') AND length(COALESCE(v_ref, '')) NOT BETWEEN 1 AND 200 THEN
    -- A resolution names the evidence actually checked.
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
  ELSIF p_kind = 'unknown' AND (v_reason IS NULL OR v_reason !~ '^[a-z0-9_.:-]{1,100}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
  END IF;

  PERFORM 1 FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  IF (public.session_journal_gate(p_session_id)->>'journaled')::boolean THEN
    RETURN jsonb_build_object('outcome', 'journal_lineage');
  END IF;
  v_holder := public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;
  RETURN ink_admission.reduce_invocation(
    p_session_id, p_tenure_id, p_epoch, p_invocation_id, p_kind, COALESCE(p_detail, '{}'::jsonb),
    NULL, NULL
  );
END;
$$;

CREATE FUNCTION public.append_session_journal(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_journal_id uuid,
  p_expected_committed_eid bigint,
  p_entry jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal text;
  v_gate jsonb;
  v_journal public.session_journals%ROWTYPE;
  v_stored public.session_journal_entries%ROWTYPE;
  v_eid bigint;
  v_bytes integer;
  v_record jsonb;
  v_projection text;
BEGIN
  IF public.session_admission_mode_refusal(p_protocol) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'mode_mismatch');
  END IF;
  v_refusal := ink_admission.journal_entry_refusal(
    p_entry, p_session_id, p_host_instance_id, p_journal_id, p_expected_committed_eid
  );
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', v_refusal);
  END IF;
  v_eid := (p_entry->>'eid')::bigint;
  v_bytes := octet_length(p_entry::text);

  PERFORM 1 FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'session_missing');
  END IF;
  IF public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  ) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'not_holder');
  END IF;
  -- The same host under a new tenure cannot reuse an earlier tenure's record.
  IF p_entry->>'writerTenureId' IS DISTINCT FROM p_tenure_id::text THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'stale_writer');
  END IF;
  v_gate := public.session_journal_gate(p_session_id);
  IF NOT (v_gate->>'journaled')::boolean OR v_gate ? 'refusal'
     OR (v_gate->>'journalId')::uuid IS DISTINCT FROM p_journal_id THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'journal_missing');
  END IF;
  SELECT * INTO v_journal FROM public.session_journals WHERE id = p_journal_id FOR UPDATE;

  IF v_eid <= v_journal.committed_eid THEN
    -- jsonb equality: key order is immaterial; null against missing, and
    -- array order, are not.
    SELECT * INTO v_stored FROM public.session_journal_entries
     WHERE journal_id = p_journal_id AND eid = v_eid;
    IF NOT FOUND OR v_stored.entry IS DISTINCT FROM p_entry THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'conflict');
    END IF;
    IF ink_admission.journal_target_refusal(p_session_id, p_tenure_id, p_entry, true) IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'stale_target');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'already_committed', 'entry', v_stored.entry,
      'committedEid', v_journal.committed_eid, 'projection', v_stored.projection
    );
  END IF;

  IF p_expected_committed_eid <> v_journal.committed_eid THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'head_mismatch');
  END IF;
  IF v_journal.hold_reason IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'journal_held');
  END IF;
  IF v_journal.committed_bytes + v_bytes > v_journal.byte_budget THEN
    -- The lineage stops here, durably: no entry, no eid, and a hold that
    -- admission, continuation and release all read.
    UPDATE public.session_journals
       SET hold_reason = 'store_capacity', held_at = now(),
           held_by_tenure_id = p_tenure_id, held_by_host_instance_id = p_host_instance_id
     WHERE id = p_journal_id;
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'capacity_held');
  END IF;
  v_refusal := ink_admission.journal_target_refusal(p_session_id, p_tenure_id, p_entry, false);
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', v_refusal);
  END IF;

  v_record := ink_admission.invocation_record(p_entry);
  BEGIN
    INSERT INTO public.session_journal_entries (journal_id, eid, entry, projection)
    VALUES (p_journal_id, v_eid, p_entry, 'none');
    IF v_record IS NULL THEN
      v_projection := 'none';
    ELSE
      v_projection := ink_admission.reduce_invocation(
        p_session_id, p_tenure_id, v_record->>'epoch', v_record->>'invocationId',
        v_record->>'kind', v_record->'detail', p_journal_id, v_eid
      )->>'outcome';
      IF v_projection IS NULL
         OR v_projection NOT IN ('recorded', 'already_recorded', 'contradiction', 'needs_reconciler') THEN
        RAISE EXCEPTION USING ERRCODE = 'IJ001', MESSAGE = COALESCE(v_projection, 'invalid');
      END IF;
      UPDATE public.session_journal_entries SET projection = v_projection
       WHERE journal_id = p_journal_id AND eid = v_eid;
    END IF;
    UPDATE public.session_journals
       SET committed_eid = v_eid, committed_bytes = committed_bytes + v_bytes
     WHERE id = p_journal_id;
  EXCEPTION WHEN SQLSTATE 'IJ001' THEN
    -- A positive record the index cannot take never becomes canonical.
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', CASE SQLERRM
      WHEN 'no_intent' THEN 'no_intent'
      WHEN 'stale' THEN 'stale_target'
      ELSE 'invalid_entry'
    END);
  END;
  RETURN jsonb_build_object(
    'outcome', 'committed', 'entry', p_entry, 'committedEid', v_eid, 'projection', v_projection
  );
END;
$$;

CREATE FUNCTION public.hold_session_journal(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability text,
  p_host_instance_id text,
  p_journal_id uuid,
  p_reason_code text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_gate jsonb;
BEGIN
  IF public.session_admission_mode_refusal(p_protocol) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'mode_mismatch');
  END IF;
  -- The writer's own failure codes (journal-writer.ts JournalFailureCode).
  -- store_capacity is the database's alone.
  IF p_reason_code IS NULL OR p_reason_code NOT IN (
    'invalid_entry', 'entry_too_large', 'queue_capacity', 'eid_exhausted', 'append_failed',
    'invalid_receipt', 'store_refused', 'projection_held', 'head_advanced'
  ) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'invalid_reason');
  END IF;
  PERFORM 1 FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'session_missing');
  END IF;
  IF public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, ink_admission.capability_hash(p_capability), p_host_instance_id
  ) IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'not_holder');
  END IF;
  v_gate := public.session_journal_gate(p_session_id);
  IF NOT (v_gate->>'journaled')::boolean OR v_gate ? 'refusal'
     OR (v_gate->>'journalId')::uuid IS DISTINCT FROM p_journal_id THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reasonCode', 'journal_missing');
  END IF;
  PERFORM 1 FROM public.session_journals WHERE id = p_journal_id FOR UPDATE;
  UPDATE public.session_journals
     SET hold_reason = p_reason_code, held_at = now(),
         held_by_tenure_id = p_tenure_id, held_by_host_instance_id = p_host_instance_id
   WHERE id = p_journal_id AND hold_reason IS NULL;
  RETURN jsonb_build_object(
    'outcome', 'held', 'journalId', p_journal_id, 'sessionId', p_session_id,
    'writerTenureId', p_tenure_id, 'hostInstanceId', p_host_instance_id,
    'reasonCode', p_reason_code
  );
END;
$$;

-- ── The other writers, run as the writer ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_tenure_lost(
  p_session_id uuid,
  p_tenure_id uuid,
  p_authority text,
  p_reason text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
  v_state text;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF length(COALESCE(p_authority, '')) NOT BETWEEN 1 AND 200
     OR p_reason IS NULL OR p_reason !~ '^[a-z0-9_.:-]{1,100}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'authority');
  END IF;
  PERFORM 1 FROM public.sessions WHERE id = p_session_id AND owner_tenure_id = p_tenure_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;
  SELECT state INTO v_state FROM public.session_owner_tenures WHERE id = p_tenure_id;
  IF v_state IS DISTINCT FROM 'held' THEN
    RETURN jsonb_build_object('outcome', 'stale', 'state', v_state);
  END IF;
  UPDATE public.session_owner_tenures
     SET state = 'recovery_required', ended_at = now(), end_evidence = p_reason,
         ended_by = p_authority, capability_hash = NULL
   WHERE id = p_tenure_id;
  UPDATE public.session_turn_generations SET state = 'recovery_required'
   WHERE session_id = p_session_id AND tenure_id = p_tenure_id AND state = 'active';
  RETURN jsonb_build_object('outcome', 'recovery_required', 'tenureId', p_tenure_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_session_admission_origin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.turn_epoch IS NULL
     AND NEW.backend_session_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.runtime_admission_mode WHERE singleton AND mode = 'conditional'
     ) THEN
    INSERT INTO public.session_admission_origins (session_id, origin)
    VALUES (NEW.id, 'created_conditional');
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.admit_command(
  p_session_id uuid,
  p_workspace_id uuid,
  p_principal_kind text,
  p_principal_id text,
  p_command_id text,
  p_payload_digest text,
  p_digest_version smallint,
  p_kind text,
  p_origin_kind text,
  p_origin_ref text,
  p_addressee text,
  p_payload jsonb,
  p_source_message_ref uuid,
  p_expected_turn text,
  p_recipients jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_payload_bytes constant integer := 8 * 1024 * 1024;
  v_mode record;
  v_session_workspace uuid;
  v_session_found boolean;
  v_existing record;
  v_existing_found boolean;
  v_message_workspace uuid;
  v_seq bigint;
  v_id uuid;
BEGIN
  SELECT mode, protocol INTO v_mode FROM public.runtime_admission_mode WHERE singleton;
  IF v_mode.mode IS DISTINCT FROM 'conditional' OR v_mode.protocol IS DISTINCT FROM p_protocol THEN
    RETURN jsonb_build_object('outcome', 'mode_mismatch', 'mode', v_mode.mode, 'protocol', v_mode.protocol);
  END IF;

  -- Typed refusals for what the table constraints would otherwise raise.
  IF p_kind IS NULL OR p_kind NOT IN ('input.enqueue', 'session.compact') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'kind');
  END IF;
  IF p_origin_kind IS NULL
     OR p_origin_kind NOT IN ('terminal', 'browser', 'channel', 'inkmail', 'wake', 'internal') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'origin');
  END IF;
  IF p_principal_kind IS NULL OR p_principal_kind NOT IN ('user', 'sb', 'system')
     OR length(COALESCE(p_principal_id, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'principal');
  END IF;
  IF length(COALESCE(p_command_id, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'commandId');
  END IF;
  IF length(COALESCE(p_payload_digest, '')) NOT BETWEEN 1 AND 200
     OR p_digest_version IS NULL OR p_digest_version < 1 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'digest');
  END IF;
  IF NOT public.session_command_recipients_valid(p_recipients) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'recipients');
  END IF;

  SELECT ai.workspace_id, true
    INTO v_session_workspace, v_session_found
    FROM public.sessions s
    LEFT JOIN public.agent_identities ai ON ai.id = s.sb_id
   WHERE s.id = p_session_id
     FOR UPDATE OF s;
  IF v_session_found IS NULL THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  -- A session with no identity, or an identity with no workspace, cannot be
  -- shown to belong to this one.
  IF v_session_workspace IS NULL OR v_session_workspace IS DISTINCT FROM p_workspace_id THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  SELECT *
    INTO v_existing
    FROM public.session_commands
   WHERE workspace_id = p_workspace_id
     AND principal_kind = p_principal_kind
     AND principal_id = p_principal_id
     AND session_id = p_session_id
     AND command_id = p_command_id;
  v_existing_found := FOUND;
  -- An Inkmail redelivery under another command id is the same command, never
  -- a second one: the message is its second identity.
  IF NOT v_existing_found AND p_origin_kind = 'inkmail' AND p_source_message_ref IS NOT NULL THEN
    SELECT *
      INTO v_existing
      FROM public.session_commands
     WHERE session_id = p_session_id AND source_message_ref = p_source_message_ref;
    v_existing_found := FOUND;
  END IF;
  IF v_existing_found THEN
    IF v_existing.payload_digest = p_payload_digest
       AND v_existing.digest_version = p_digest_version
       AND v_existing.kind = p_kind
       AND v_existing.principal_kind = p_principal_kind
       AND v_existing.principal_id = p_principal_id
       AND v_existing.origin_kind = p_origin_kind
       AND v_existing.origin_ref IS NOT DISTINCT FROM p_origin_ref
       AND v_existing.addressee IS NOT DISTINCT FROM p_addressee
       AND v_existing.expected_turn IS NOT DISTINCT FROM p_expected_turn
       AND v_existing.source_message_ref IS NOT DISTINCT FROM p_source_message_ref THEN
      RETURN jsonb_build_object(
        'outcome', 'existing', 'id', v_existing.id, 'admissionSeq', v_existing.admission_seq,
        'state', v_existing.state, 'revision', v_existing.revision
      );
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'id', v_existing.id);
  END IF;

  IF p_origin_kind = 'inkmail' THEN
    IF p_source_message_ref IS NULL OR p_payload IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'field', 'source');
    END IF;
    SELECT t.workspace_id INTO v_message_workspace
      FROM public.inbox_thread_messages m
      JOIN public.inbox_threads t ON t.id = m.thread_id
     WHERE m.id = p_source_message_ref;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'source_unavailable');
    END IF;
    IF v_message_workspace IS DISTINCT FROM p_workspace_id THEN
      RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
  ELSIF p_source_message_ref IS NOT NULL OR p_payload IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'payload');
  ELSIF octet_length(p_payload::text) > c_max_payload_bytes THEN
    RETURN jsonb_build_object('outcome', 'too_large', 'limitBytes', c_max_payload_bytes);
  END IF;

  -- Rows are tombstoned, never deleted, so the maximum never falls back.
  SELECT COALESCE(max(admission_seq), 0) + 1 INTO v_seq
    FROM public.session_commands
   WHERE session_id = p_session_id;

  INSERT INTO public.session_commands (
    session_id, workspace_id, principal_kind, principal_id, command_id,
    payload_digest, digest_version, kind, origin_kind, origin_ref, addressee,
    payload, source_message_ref, source_message_id, expected_turn,
    admission_seq, state
  ) VALUES (
    p_session_id, p_workspace_id, p_principal_kind, p_principal_id, p_command_id,
    p_payload_digest, p_digest_version, p_kind, p_origin_kind, p_origin_ref, p_addressee,
    p_payload, p_source_message_ref, p_source_message_ref, p_expected_turn,
    v_seq, 'queued'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.session_command_events (command_uuid, revision, state)
  VALUES (v_id, 1, 'queued');
  PERFORM ink_admission.session_command_record_receipts(v_id, 1, p_principal_kind, p_principal_id, p_recipients);

  RETURN jsonb_build_object(
    'outcome', 'admitted', 'id', v_id, 'admissionSeq', v_seq, 'state', 'queued', 'revision', 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_command(
  p_command_uuid uuid,
  p_expected_revision integer,
  p_expected_state text,
  p_new_state text,
  p_reason_code text,
  p_mark_started boolean,
  p_executing_epoch text,
  p_recipients jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_mode record;
  v_session_id uuid;
  v_command record;
  v_started boolean;
  v_revision integer;
BEGIN
  SELECT mode, protocol INTO v_mode FROM public.runtime_admission_mode WHERE singleton;
  IF v_mode.mode IS DISTINCT FROM 'conditional' OR v_mode.protocol IS DISTINCT FROM p_protocol THEN
    RETURN jsonb_build_object('outcome', 'mode_mismatch', 'mode', v_mode.mode, 'protocol', v_mode.protocol);
  END IF;

  IF p_new_state IS NULL OR p_new_state NOT IN (
    'stored', 'queued', 'waiting_for_consumer', 'backend_accepted', 'input_consumed',
    'completed', 'rejected', 'interrupted', 'unknown'
  ) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'state');
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1
     OR p_expected_state IS NULL OR p_expected_state NOT IN (
       'stored', 'queued', 'waiting_for_consumer', 'backend_accepted', 'input_consumed',
       'completed', 'rejected', 'interrupted', 'unknown'
     ) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'expected');
  END IF;
  IF p_reason_code IS NOT NULL AND p_reason_code !~ '^[a-z0-9_.:-]{1,100}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'reasonCode');
  END IF;
  IF NOT public.session_command_recipients_valid(p_recipients) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'recipients');
  END IF;

  -- The session lock first, as admission takes it, then the command row.
  SELECT session_id INTO v_session_id FROM public.session_commands WHERE id = p_command_uuid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;
  PERFORM 1 FROM public.sessions WHERE id = v_session_id FOR UPDATE;
  SELECT c.state, c.revision, c.started_at, c.principal_kind, c.principal_id
    INTO v_command
    FROM public.session_commands c
   WHERE c.id = p_command_uuid
     FOR UPDATE;
  -- The command can go between the first read and the locks, with its session.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'missing');
  END IF;

  IF v_command.revision IS DISTINCT FROM p_expected_revision
     OR v_command.state IS DISTINCT FROM p_expected_state THEN
    RETURN jsonb_build_object(
      'outcome', 'stale', 'revision', v_command.revision, 'state', v_command.state
    );
  END IF;

  IF v_command.state IN ('completed', 'rejected', 'interrupted') THEN
    RETURN jsonb_build_object('outcome', 'illegal_transition', 'from', v_command.state, 'to', p_new_state);
  END IF;

  v_started := v_command.started_at IS NOT NULL
    OR COALESCE(p_mark_started, false)
    OR p_new_state IN ('backend_accepted', 'input_consumed', 'completed', 'interrupted', 'unknown');

  IF v_started AND p_new_state IN ('stored', 'queued', 'waiting_for_consumer', 'rejected')
     AND NOT (
       v_command.started_at IS NULL
       AND COALESCE(p_mark_started, false)
       AND p_new_state = v_command.state
     ) THEN
    RETURN jsonb_build_object('outcome', 'illegal_transition', 'from', v_command.state, 'to', p_new_state);
  END IF;

  IF p_new_state = 'unknown' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_recipients, '[]'::jsonb)) r
     WHERE r->>'kind' = 'operator'
  ) THEN
    RETURN jsonb_build_object('outcome', 'notice_required');
  END IF;

  v_revision := v_command.revision + 1;
  UPDATE public.session_commands
     SET state = p_new_state,
         reason_code = p_reason_code,
         revision = v_revision,
         started_at = CASE WHEN v_started THEN COALESCE(started_at, now()) ELSE started_at END,
         executing_epoch = COALESCE(p_executing_epoch, executing_epoch)
   WHERE id = p_command_uuid;

  INSERT INTO public.session_command_events (command_uuid, revision, state, reason_code)
  VALUES (p_command_uuid, v_revision, p_new_state, p_reason_code);
  PERFORM ink_admission.session_command_record_receipts(
    p_command_uuid, v_revision, v_command.principal_kind, v_command.principal_id, p_recipients
  );

  RETURN jsonb_build_object('outcome', 'transitioned', 'revision', v_revision, 'state', p_new_state);
END;
$$;

-- ── The sessions guard ──────────────────────────────────────────────────────
CREATE FUNCTION public.session_authority_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user = 'ink_admission_writer' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a new session cannot arrive with an owner tenure'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The WHEN clause admits only a change to an authority column. It is
  -- refused when either side of it is an admission lineage, whatever the
  -- current mode: the evidence, not the mode, decides.
  IF OLD.owner_tenure_id IS NOT NULL OR NEW.owner_tenure_id IS NOT NULL
     OR OLD.journal_kind IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.session_admission_origins o WHERE o.session_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.session_journals j WHERE j.session_id = OLD.id) THEN
    RAISE EXCEPTION 'session % is an admission lineage: its owner and turn change only through admission', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_authority_guard_insert
  AFTER INSERT ON public.sessions
  FOR EACH ROW
  WHEN (NEW.owner_tenure_id IS NOT NULL)
  EXECUTE FUNCTION public.session_authority_guard();

CREATE TRIGGER session_authority_guard_update
  AFTER UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (OLD.owner_tenure_id IS DISTINCT FROM NEW.owner_tenure_id
        OR OLD.turn_epoch IS DISTINCT FROM NEW.turn_epoch)
  EXECUTE FUNCTION public.session_authority_guard();

-- ── Evidence outlives no parent ─────────────────────────────────────────────
-- These six edges cascaded from tables service_role writes. Internal edges
-- between admission tables keep their cascades: only the writer or an
-- administrator can delete their parents. session_commands.source_message_id
-- stays SET NULL, as slice A designed it: the dedupe key is source_message_ref.
ALTER TABLE public.session_commands
  DROP CONSTRAINT session_commands_session_id_fkey,
  ADD CONSTRAINT session_commands_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE RESTRICT,
  DROP CONSTRAINT session_commands_workspace_id_fkey,
  ADD CONSTRAINT session_commands_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;
ALTER TABLE public.session_admission_origins
  DROP CONSTRAINT session_admission_origins_session_id_fkey,
  ADD CONSTRAINT session_admission_origins_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.session_owner_tenures
  DROP CONSTRAINT session_owner_tenures_session_id_fkey,
  ADD CONSTRAINT session_owner_tenures_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.session_turn_generations
  DROP CONSTRAINT session_turn_generations_session_id_fkey,
  ADD CONSTRAINT session_turn_generations_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.session_journals
  DROP CONSTRAINT session_journals_session_id_fkey,
  ADD CONSTRAINT session_journals_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;

-- ── Ownership and grants ────────────────────────────────────────────────────
ALTER TABLE public.session_admission_origins OWNER TO ink_admission_writer;
ALTER TABLE public.session_owner_tenures OWNER TO ink_admission_writer;
ALTER TABLE public.session_turn_generations OWNER TO ink_admission_writer;
ALTER TABLE public.session_commands OWNER TO ink_admission_writer;
ALTER TABLE public.session_command_events OWNER TO ink_admission_writer;
ALTER TABLE public.session_command_receipts OWNER TO ink_admission_writer;
REVOKE ALL ON TABLE public.session_admission_origins, public.session_owner_tenures,
  public.session_turn_generations, public.session_commands, public.session_command_events,
  public.session_command_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.session_admission_origins, public.session_owner_tenures,
  public.session_turn_generations, public.session_commands, public.session_command_events,
  public.session_command_receipts TO service_role;

-- The activation switch is an operator's, not the API's.
REVOKE ALL ON TABLE public.runtime_admission_mode FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.runtime_admission_mode TO service_role;

-- What the writer's functions now touch outside its own tables.
GRANT UPDATE (turn_epoch, lifecycle) ON TABLE public.sessions TO ink_admission_writer;
GRANT SELECT ON TABLE public.studios, public.agent_identities, public.inbox_threads,
  public.inbox_thread_messages TO ink_admission_writer;
GRANT UPDATE (lease) ON TABLE public.studios TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.normalize_worktree_path(text) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_command_recipients_valid(jsonb) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_dispatch_head(uuid) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_turn_unresolved_invocations(uuid, text, boolean) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_journal_gate(uuid) TO ink_admission_writer;

-- Every caller of the holder check now runs as the writer.
REVOKE ALL ON FUNCTION public.session_tenure_holder_refusal(uuid, uuid, text, text) FROM service_role;

-- The definers: owned by the writer, callable by service_role only.
ALTER FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.mark_tenure_lost(uuid, uuid, text, text, integer) OWNER TO ink_admission_writer;
ALTER FUNCTION public.record_session_admission_origin() OWNER TO ink_admission_writer;
ALTER FUNCTION public.admit_command(uuid, uuid, text, text, text, text, smallint, text, text, text, text, jsonb, uuid, text, jsonb, integer)
  OWNER TO ink_admission_writer;
ALTER FUNCTION public.transition_command(uuid, integer, text, text, text, boolean, text, jsonb, integer)
  OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.capability_hash(text) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.session_command_record_receipts(uuid, integer, text, text, jsonb) OWNER TO ink_admission_writer;

REVOKE ALL ON FUNCTION ink_admission.capability_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.session_command_record_receipts(uuid, integer, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.session_authority_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_session_admission_origin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.admit_leased_turn(uuid, uuid, text, text, text, text, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer) TO service_role;

REVOKE CREATE ON SCHEMA public FROM ink_admission_writer;
REVOKE CREATE ON SCHEMA ink_admission FROM ink_admission_writer;
