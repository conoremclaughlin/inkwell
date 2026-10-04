-- Owner tenure and turn generations, slice A2 (ink://specs/live-agent-surfaces v29
-- R1/R3; pr:701 c38fffc3, e9423a9f, 9aa4d385).
--
-- DARK, like slice A: nothing calls these, and every function refuses with
-- mode_mismatch unless runtime_admission_mode is 'conditional' at the caller's
-- protocol. In legacy mode the one trigger added here does nothing.
--
-- The authority is the sessions row and nothing else. It carries two pointers:
--   owner_tenure_id  the registered owner that may advance the session, and
--   turn_epoch       the turn it is running or last ran (existing column).
-- Every function below takes that row FOR UPDATE before reading or writing
-- anything, so both pointers change under one compare-and-set. The tables
-- below the row are evidence; none of them is consulted as authority without
-- the pointer that names it, so they are not a second lease registry.
--
-- Lock order: the sessions row, then rows of these tables, then commands.
-- When studio leases join admission (a later slice), lease locks come first,
-- in claim_turn_epoch's order (studio path advisory lock, studio row, then the
-- sessions row), so no path takes them the other way round.
--
-- What each state means:
--   tenure  held               an owner holds the session, with or without a turn
--           released           its owner ended it with full evidence
--           recovery_required  its owner is gone without full evidence: occupied
--           reconciled         an authorized reconciler cleared it with evidence
--   turn    active             running under its tenure
--           finished           its owner reported the turn complete; the tenure
--                              is unchanged (a Stop never releases)
--           recovery_required  its outcome is unknown: occupied
-- A session with no tenure pointer is NOT free: unless the admission
-- authority recorded its creation (session_admission_origins), its history is
-- unverified and it counts as occupied.

-- ── The second pointer ──────────────────────────────────────────────────────
-- No foreign key: only the functions below write it, always to a tenure of the
-- same session, inside the same transaction that inserts or updates that tenure.
ALTER TABLE public.sessions ADD COLUMN owner_tenure_id uuid;

-- ── Positive never-owned evidence ───────────────────────────────────────────
-- Recorded in the transaction that creates the session, when the database is
-- in conditional mode and no transcript or turn exists yet. Every session
-- created before that, null markers or not, has no row here and is unverified.
CREATE TABLE public.session_admission_origins (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('created_conditional')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.record_session_admission_origin()
RETURNS trigger
LANGUAGE plpgsql
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

CREATE TRIGGER session_admission_origin
  AFTER INSERT ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.record_session_admission_origin();

-- ── Tenures ─────────────────────────────────────────────────────────────────
-- The holder proves itself with a capability: a random secret minted when the
-- tenure is registered, of which only the hash is stored here. Knowing the
-- tenure id is not enough. The hash is cleared when the tenure ends, so the
-- capability lives exactly as long as the tenure.
CREATE TABLE public.session_owner_tenures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('server_hosted', 'interactive_wrapper', 'native_external')),
  state text NOT NULL CHECK (state IN ('held', 'released', 'recovery_required', 'reconciled')),
  capability_hash text CHECK (capability_hash IS NULL OR capability_hash ~ '^sha256:[0-9a-f]{64}$'),
  host_instance_id text NOT NULL CHECK (length(host_instance_id) BETWEEN 1 AND 200),
  host_boot_id text CHECK (host_boot_id IS NULL OR length(host_boot_id) BETWEEN 1 AND 200),
  host_id text CHECK (host_id IS NULL OR length(host_id) BETWEEN 1 AND 200),
  owner_pid integer CHECK (owner_pid IS NULL OR owner_pid > 0),
  owner_start_identity text CHECK (owner_start_identity IS NULL OR length(owner_start_identity) <= 200),
  endpoint jsonb,
  registered_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_evidence text CHECK (end_evidence IS NULL OR end_evidence ~ '^[a-z0-9_.:-]{1,100}$'),
  ended_by text CHECK (ended_by IS NULL OR length(ended_by) BETWEEN 1 AND 200),
  CONSTRAINT session_owner_tenures_open_iff_held CHECK ((state = 'held') = (ended_at IS NULL)),
  CONSTRAINT session_owner_tenures_capability_iff_held
    CHECK ((state = 'held') = (capability_hash IS NOT NULL)),
  CONSTRAINT session_owner_tenures_owner_pair
    CHECK ((owner_pid IS NULL) = (owner_start_identity IS NULL))
);

-- At most one occupying tenure per session, whatever any caller believes.
CREATE UNIQUE INDEX session_owner_tenures_one_occupying
  ON public.session_owner_tenures (session_id)
  WHERE state IN ('held', 'recovery_required');

-- ── Turn generations ────────────────────────────────────────────────────────
CREATE TABLE public.session_turn_generations (
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  epoch text NOT NULL CHECK (length(epoch) BETWEEN 1 AND 200),
  tenure_id uuid NOT NULL REFERENCES public.session_owner_tenures(id) ON DELETE CASCADE,
  -- NULL only on the coverage row a reconciler writes for a legacy epoch that
  -- ran before admission existed; every admitted turn names its command.
  command_uuid uuid REFERENCES public.session_commands(id) ON DELETE CASCADE,
  prior_epoch text,
  state text NOT NULL CHECK (state IN ('active', 'finished', 'recovery_required')),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  finish_evidence text CHECK (finish_evidence IS NULL OR finish_evidence ~ '^[a-z0-9_.:-]{1,100}$'),
  PRIMARY KEY (session_id, epoch),
  CONSTRAINT session_turn_generations_finished_pair
    CHECK ((state = 'finished') = (finished_at IS NOT NULL)),
  CONSTRAINT session_turn_generations_command_or_legacy_coverage
    CHECK (command_uuid IS NOT NULL OR (state = 'finished' AND finish_evidence = 'reconciled_legacy_epoch'))
);

CREATE UNIQUE INDEX session_turn_generations_one_active
  ON public.session_turn_generations (session_id)
  WHERE state = 'active';

-- ── Invocations: the admission index of the journal ─────────────────────────
-- The journal stays the canonical record of each provider spawn. Admission
-- has to see, inside its own transaction, whether any spawn of a turn is still
-- pending or uncertain, so the host records the same facts here as it records
-- them there, keyed by the same invocation identity.
--   bound          a verified process identity is recorded (process_pid). A
--                  transcript binding is the provider's own report after the
--                  spawn, so it is backend execution evidence too; a resume
--                  target chosen before spawn is not recorded here;
--   resolved       resolution is tree_quiescent (with the attestation actually
--                  checked) or not_spawned (a refusal recorded before spawn);
--   contradiction  two records disagreed: its resolution is cleared, the
--                  holder's evidence is no longer accepted for it, and only a
--                  reconciler can resolve it.
--   unknown        the holder lost track of it (unknown_reason): any earlier
--                  resolution is cleared, and only a reconciler can resolve it.
-- Parent exit and an empty process group are recorded as what they are and
-- never count as quiescence.
CREATE TABLE public.session_turn_invocations (
  session_id uuid NOT NULL,
  epoch text NOT NULL,
  invocation_id text NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 200),
  process_pid integer CHECK (process_pid IS NULL OR process_pid > 0),
  process_start_identity text CHECK (process_start_identity IS NULL OR length(process_start_identity) <= 200),
  provider_transcript_id text CHECK (provider_transcript_id IS NULL OR length(provider_transcript_id) <= 200),
  parent_exited boolean NOT NULL DEFAULT false,
  group_empty boolean NOT NULL DEFAULT false,
  resolution text CHECK (resolution IN ('tree_quiescent', 'not_spawned')),
  resolution_evidence_ref text CHECK (resolution_evidence_ref IS NULL OR length(resolution_evidence_ref) BETWEEN 1 AND 200),
  unknown_reason text CHECK (unknown_reason IS NULL OR unknown_reason ~ '^[a-z0-9_.:-]{1,100}$'),
  contradiction boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, epoch, invocation_id),
  FOREIGN KEY (session_id, epoch)
    REFERENCES public.session_turn_generations (session_id, epoch) ON DELETE CASCADE,
  CONSTRAINT session_turn_invocations_binding_pair
    CHECK ((process_pid IS NULL) = (process_start_identity IS NULL)),
  CONSTRAINT session_turn_invocations_resolution_evidence
    CHECK (resolution IS NULL OR resolution_evidence_ref IS NOT NULL),
  CONSTRAINT session_turn_invocations_not_spawned_unbound
    CHECK (resolution IS DISTINCT FROM 'not_spawned'
           OR (process_pid IS NULL AND provider_transcript_id IS NULL))
);

CREATE TRIGGER session_turn_invocations_updated_at
  BEFORE UPDATE ON public.session_turn_invocations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.session_admission_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_owner_tenures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_turn_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_turn_invocations ENABLE ROW LEVEL SECURITY;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- NULL when the database speaks the caller's protocol in conditional mode;
-- otherwise the refusal to return.
CREATE FUNCTION public.session_admission_mode_refusal(p_protocol integer)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN m.mode IS NOT DISTINCT FROM 'conditional' AND m.protocol IS NOT DISTINCT FROM p_protocol
      THEN NULL
    ELSE jsonb_build_object('outcome', 'mode_mismatch', 'mode', m.mode, 'protocol', m.protocol)
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.runtime_admission_mode m ON m.singleton
$$;

-- Unresolved spawns of one turn. The same owner continuing needs every spawn
-- bound or resolved, and none uncertain: a tracked background process of the
-- owner's own is not unknown merely because it is alive. Anyone else taking
-- over, and any release, needs every spawn resolved by evidence.
CREATE FUNCTION public.session_turn_unresolved_invocations(
  p_session_id uuid,
  p_epoch text,
  p_require_resolution boolean
)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)::integer
    FROM public.session_turn_invocations i
   WHERE i.session_id = p_session_id
     AND i.epoch = p_epoch
     AND i.resolution IS NULL
     AND (
       i.contradiction
       OR p_require_resolution
       OR i.process_pid IS NULL
       OR i.unknown_reason IS NOT NULL
     )
$$;

-- NULL when the caller holds the session's current tenure: the pointer names
-- it, it is held, and the capability and host instance match. Call it only
-- with the sessions row already locked.
CREATE FUNCTION public.session_tenure_holder_refusal(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN s.owner_tenure_id IS DISTINCT FROM p_tenure_id THEN 'not_holder'
    WHEN t.id IS NULL OR t.state IS DISTINCT FROM 'held' THEN 'not_holder'
    WHEN t.capability_hash IS DISTINCT FROM p_capability_hash THEN 'not_holder'
    WHEN t.host_instance_id IS DISTINCT FROM p_host_instance_id THEN 'not_holder'
    ELSE NULL
  END
  FROM public.sessions s
  LEFT JOIN public.session_owner_tenures t
    ON t.id = s.owner_tenure_id AND t.session_id = s.id
  WHERE s.id = p_session_id
$$;

-- ── register_tenure ─────────────────────────────────────────────────────────
-- Transition 1: an owner registers before its first turn. The expected prior
-- is exact: never_owned (positive creation evidence, and nothing has ever run),
-- or the named prior tenure, released or reconciled, with every spawn of every
-- turn under it resolved and no command still holding the session.
CREATE FUNCTION public.register_tenure(
  p_session_id uuid,
  p_expected jsonb,
  p_mode text,
  p_capability_hash text,
  p_host jsonb,
  p_owner jsonb,
  p_endpoint jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
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
  IF p_capability_hash IS NULL OR p_capability_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'capability');
  END IF;
  IF jsonb_typeof(p_host) IS DISTINCT FROM 'object'
     OR length(COALESCE(p_host->>'instanceId', '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'host');
  END IF;
  IF p_owner IS NOT NULL AND (
       jsonb_typeof(p_owner) IS DISTINCT FROM 'object'
       OR (p_owner->>'pid') IS NULL OR (p_owner->>'pid') !~ '^[1-9][0-9]{0,9}$'
       OR length(COALESCE(p_owner->>'startIdentity', '')) NOT BETWEEN 1 AND 200
     ) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'owner');
  END IF;

  SELECT s.id, s.owner_tenure_id, s.turn_epoch INTO v_session
    FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;

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
     WHERE g.session_id = p_session_id AND g.tenure_id = v_prior.id;
    IF v_unresolved > 0 OR EXISTS (
      SELECT 1 FROM public.session_turn_generations g
       WHERE g.session_id = p_session_id AND g.state IN ('active', 'recovery_required')
    ) THEN
      RETURN jsonb_build_object('outcome', 'unresolved', 'tenureId', v_prior.id);
    END IF;
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
    p_session_id, p_mode, 'held', p_capability_hash, p_host->>'instanceId', p_host->>'bootId',
    p_host->>'hostId', (p_owner->>'pid')::integer, p_owner->>'startIdentity', p_endpoint
  )
  RETURNING id INTO v_id;

  UPDATE public.sessions SET owner_tenure_id = v_id WHERE id = p_session_id;

  RETURN jsonb_build_object('outcome', 'registered', 'tenureId', v_id);
END;
$$;

-- ── admit_turn ──────────────────────────────────────────────────────────────
-- Transition 2: the holder begins a turn for the session's FIFO head command.
-- The expected prior epoch is the session's current turn_epoch, exactly (null
-- before the first turn). The prior turn must not be running, no turn may be
-- uncertain, and every spawn of every turn the session ran is checked: bound
-- or resolved for the holder's own turns, resolved for any other tenure's.
-- Release of the tenure is never required.
CREATE FUNCTION public.admit_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text,
  p_expected_prior_epoch text,
  p_epoch text,
  p_command_uuid uuid,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
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
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_tenure_id IS NULL OR p_capability_hash IS NULL OR p_host_instance_id IS NULL THEN
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;

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

  v_head := public.session_dispatch_head(p_session_id);
  IF v_head->>'hold' IS NOT NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'held', 'hold', v_head->>'hold', 'holdingCommand', v_head->>'holdingCommand'
    );
  END IF;
  IF v_head->>'head' IS DISTINCT FROM p_command_uuid::text THEN
    RETURN jsonb_build_object('outcome', 'not_fifo_head', 'head', v_head->>'head');
  END IF;

  PERFORM set_config('ink.turn_admission', p_epoch, true);
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

-- ── finish_turn ─────────────────────────────────────────────────────────────
-- Transition 3: the holder reports its active turn complete (a correlated
-- Stop, or the runner's result). The tenure is unchanged: finishing a turn
-- never frees the session for anyone else.
CREATE FUNCTION public.finish_turn(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text,
  p_epoch text,
  p_evidence text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
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

-- ── release_tenure ──────────────────────────────────────────────────────────
-- Transition 4: the holder relinquishes the session. Only with no turn
-- running, every spawn of every turn under this tenure resolved by evidence,
-- and no command holding the session. Interactive-wrapper exit, controller
-- retirement and a view detaching are different events; whichever ended the
-- tenure is recorded, and none of them stands in for the spawn evidence. Once
-- released, the old holder's capability is gone, so a retained controller
-- object cannot admit, finish or record anything afterwards.
CREATE FUNCTION public.release_tenure(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text,
  p_evidence text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_unresolved integer;
  v_head jsonb;
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_turn_generations g
     WHERE g.session_id = p_session_id AND g.state IN ('active', 'recovery_required')
  ) THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;
  SELECT COALESCE(sum(public.session_turn_unresolved_invocations(p_session_id, g.epoch, true)), 0)
    INTO v_unresolved
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.tenure_id = p_tenure_id;
  IF v_unresolved > 0 THEN
    RETURN jsonb_build_object('outcome', 'unresolved', 'invocations', v_unresolved);
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

-- ── record_invocation ───────────────────────────────────────────────────────
-- The holder records what it knows about one spawn of its active turn, under
-- the invocation identity the journal uses. Repeating an identical record is a
-- no-op that reports what is stored. A process binding that disagrees with the
-- stored one, a second transcript, or not_spawned after a binding marks the
-- invocation contradictory, and nothing about it is trusted after that.
CREATE FUNCTION public.record_invocation(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
  p_host_instance_id text,
  p_epoch text,
  p_invocation_id text,
  p_kind text,
  p_detail jsonb,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_refusal jsonb;
  v_holder text;
  v_state text;
  v_inv record;
  v_pid integer;
  v_start text;
  v_transcript text;
  v_ref text;
  v_reason text;
  v_contradiction boolean := false;
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
    IF (p_detail->>'pid') IS NULL OR (p_detail->>'pid') !~ '^[1-9][0-9]{0,9}$'
       OR length(COALESCE(v_start, '')) NOT BETWEEN 1 AND 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'field', 'detail');
    END IF;
    v_pid := (p_detail->>'pid')::integer;
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
  v_holder := public.session_tenure_holder_refusal(
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
  );
  IF v_holder IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_holder);
  END IF;
  SELECT g.state INTO v_state
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.epoch = p_epoch AND g.tenure_id = p_tenure_id;
  IF v_state IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;

  SELECT * INTO v_inv FROM public.session_turn_invocations
   WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Only an intent opens an invocation, and only while its turn is running.
    IF p_kind <> 'intent' THEN
      RETURN jsonb_build_object('outcome', 'no_intent');
    END IF;
    IF v_state <> 'active' THEN
      RETURN jsonb_build_object('outcome', 'stale');
    END IF;
    INSERT INTO public.session_turn_invocations (session_id, epoch, invocation_id)
    VALUES (p_session_id, p_epoch, p_invocation_id);
    RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
  END IF;

  IF p_kind = 'intent' THEN
    RETURN jsonb_build_object('outcome', 'already_recorded', 'kind', p_kind);
  ELSIF v_inv.contradiction THEN
    RETURN jsonb_build_object('outcome', 'contradiction', 'kind', p_kind);
  ELSIF p_kind = 'process_binding' THEN
    IF v_inv.process_pid IS NULL THEN
      IF v_inv.resolution = 'not_spawned' THEN
        v_contradiction := true;
      ELSE
        UPDATE public.session_turn_invocations
           SET process_pid = v_pid, process_start_identity = v_start
         WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
        RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
      END IF;
    ELSIF v_inv.process_pid = v_pid AND v_inv.process_start_identity = v_start THEN
      RETURN jsonb_build_object('outcome', 'already_recorded', 'kind', p_kind);
    ELSE
      v_contradiction := true;
    END IF;
  ELSIF p_kind = 'transcript_binding' THEN
    IF v_inv.resolution = 'not_spawned' THEN
      v_contradiction := true;
    ELSIF v_inv.provider_transcript_id IS NULL THEN
      UPDATE public.session_turn_invocations SET provider_transcript_id = v_transcript
       WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
      RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
    ELSIF v_inv.provider_transcript_id = v_transcript THEN
      RETURN jsonb_build_object('outcome', 'already_recorded', 'kind', p_kind);
    ELSE
      v_contradiction := true;
    END IF;
  ELSIF p_kind = 'parent_exited' THEN
    UPDATE public.session_turn_invocations SET parent_exited = true
     WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
    RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
  ELSIF p_kind = 'group_empty' THEN
    -- Recorded as a limited observation: a descendant can leave the group.
    UPDATE public.session_turn_invocations SET group_empty = true
     WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
    RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
  ELSIF p_kind IN ('not_spawned', 'tree_quiescent') AND v_inv.unknown_reason IS NOT NULL THEN
    -- The holder said it lost track of this spawn; only a reconciler resolves it now.
    RETURN jsonb_build_object('outcome', 'needs_reconciler', 'kind', p_kind);
  ELSIF p_kind = 'not_spawned' THEN
    IF v_inv.process_pid IS NOT NULL OR v_inv.provider_transcript_id IS NOT NULL
       OR v_inv.resolution = 'tree_quiescent' THEN
      v_contradiction := true;
    ELSIF v_inv.resolution = 'not_spawned' THEN
      RETURN jsonb_build_object('outcome', 'already_recorded', 'kind', p_kind);
    ELSE
      UPDATE public.session_turn_invocations
         SET resolution = 'not_spawned', resolution_evidence_ref = v_ref
       WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
      RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
    END IF;
  ELSIF p_kind = 'tree_quiescent' THEN
    IF v_inv.resolution = 'not_spawned' THEN
      v_contradiction := true;
    ELSIF v_inv.resolution = 'tree_quiescent' THEN
      RETURN jsonb_build_object('outcome', 'already_recorded', 'kind', p_kind);
    ELSE
      UPDATE public.session_turn_invocations
         SET resolution = 'tree_quiescent', resolution_evidence_ref = v_ref
       WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
      RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
    END IF;
  ELSIF p_kind = 'unknown' THEN
    -- New uncertainty outranks an earlier resolution: it is cleared, not kept beside it.
    UPDATE public.session_turn_invocations
       SET unknown_reason = v_reason, resolution = NULL, resolution_evidence_ref = NULL
     WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
    RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
  END IF;

  IF v_contradiction THEN
    UPDATE public.session_turn_invocations
       SET contradiction = true, resolution = NULL, resolution_evidence_ref = NULL
     WHERE session_id = p_session_id AND epoch = p_epoch AND invocation_id = p_invocation_id;
    RETURN jsonb_build_object('outcome', 'contradiction', 'kind', p_kind);
  END IF;
  RETURN jsonb_build_object('outcome', 'invalid', 'field', 'kind');
END;
$$;

-- ── Reconciler paths ────────────────────────────────────────────────────────
-- Separate capabilities from the holder's: the server authorizes the
-- reconciler or operator, and these record who acted and on what evidence.
--
-- mark_tenure_lost (transition 5): the holder is gone without full evidence.
-- The session stays occupied until reconcile_tenure.
CREATE FUNCTION public.mark_tenure_lost(
  p_session_id uuid,
  p_tenure_id uuid,
  p_authority text,
  p_reason text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
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

-- reconcile_tenure (transition 6): clears an occupying tenure, or a session's
-- unverified history, on positive evidence of the right kind:
--   boot_changed       the tenure recorded the machine it ran on (host_id) and
--                      that machine's boot id, and the reconciler reports the
--                      same machine with a different boot. A different machine,
--                      a new host instance, or a missing machine or boot id is
--                      not this machine rebooting, and is refused. It clears
--                      process overlap only; effects stay with their commands.
--   owner_tree_gone    the reconciler verified the owner and its whole process
--                      tree gone, by the attestation named in p_evidence_ref.
--   operator_decision  an authorized operator's decision, naming its evidence.
--                      It accepts effect risk and never proves a process gone,
--                      so it clears only unverified history (no tenure), and is
--                      refused for an existing tenure.
-- Clearing unverified history keeps a legacy turn_epoch and records coverage
-- for it, so the next owner's first turn names that epoch as its exact prior.
CREATE FUNCTION public.reconcile_tenure(
  p_session_id uuid,
  p_expected_tenure_id uuid,
  p_evidence text,
  p_current_boot_id text,
  p_current_host_id text,
  p_evidence_ref text,
  p_authority text,
  p_host_instance_id text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_refusal jsonb;
  v_session record;
  v_tenure record;
  v_id uuid;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  IF p_evidence IS NULL OR p_evidence NOT IN ('boot_changed', 'owner_tree_gone', 'operator_decision')
     OR length(COALESCE(p_authority, '')) NOT BETWEEN 1 AND 200
     OR length(COALESCE(p_host_instance_id, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'evidence');
  END IF;
  IF p_evidence = 'boot_changed' AND length(COALESCE(p_current_boot_id, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'boot');
  END IF;
  IF p_evidence IN ('owner_tree_gone', 'operator_decision')
     AND length(COALESCE(p_evidence_ref, '')) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'evidenceRef');
  END IF;

  SELECT s.id, s.owner_tenure_id, s.turn_epoch INTO v_session
    FROM public.sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'session_missing');
  END IF;
  IF v_session.owner_tenure_id IS DISTINCT FROM p_expected_tenure_id THEN
    RETURN jsonb_build_object('outcome', 'stale_expectation', 'tenureId', v_session.owner_tenure_id);
  END IF;

  IF v_session.owner_tenure_id IS NULL THEN
    IF p_evidence <> 'operator_decision' THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'unverified_history_needs_operator');
    END IF;
    -- The decision becomes a reconciled tenure: the next owner names it.
    INSERT INTO public.session_owner_tenures (
      session_id, mode, state, host_instance_id, ended_at, end_evidence, ended_by
    ) VALUES (
      p_session_id, 'server_hosted', 'reconciled', p_host_instance_id, now(), p_evidence, p_authority
    )
    RETURNING id INTO v_id;
    UPDATE public.sessions SET owner_tenure_id = v_id WHERE id = p_session_id;
    IF v_session.turn_epoch IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.session_turn_generations g
       WHERE g.session_id = p_session_id AND g.epoch = v_session.turn_epoch
    ) THEN
      INSERT INTO public.session_turn_generations (
        session_id, epoch, tenure_id, command_uuid, prior_epoch, state, finished_at, finish_evidence
      ) VALUES (
        p_session_id, v_session.turn_epoch, v_id, NULL, NULL, 'finished', now(), 'reconciled_legacy_epoch'
      );
    END IF;
    RETURN jsonb_build_object('outcome', 'reconciled', 'tenureId', v_id);
  END IF;

  IF p_evidence = 'operator_decision' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'operator_decision_cannot_prove_quiescence');
  END IF;

  SELECT t.id, t.state, t.host_boot_id, t.host_id INTO v_tenure
    FROM public.session_owner_tenures t
   WHERE t.id = v_session.owner_tenure_id AND t.session_id = p_session_id;
  IF NOT FOUND OR v_tenure.state NOT IN ('held', 'recovery_required') THEN
    RETURN jsonb_build_object('outcome', 'stale', 'state', v_tenure.state);
  END IF;
  IF p_evidence = 'boot_changed' THEN
    IF v_tenure.host_id IS NULL OR p_current_host_id IS NULL
       OR v_tenure.host_id IS DISTINCT FROM p_current_host_id THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'machine_scope_absent_or_different');
    END IF;
    IF v_tenure.host_boot_id IS NULL OR v_tenure.host_boot_id = p_current_boot_id THEN
      RETURN jsonb_build_object('outcome', 'refused', 'reason', 'boot_evidence_absent_or_same');
    END IF;
  END IF;

  UPDATE public.session_owner_tenures
     SET state = 'reconciled', ended_at = COALESCE(ended_at, now()), end_evidence = p_evidence,
         ended_by = p_authority, capability_hash = NULL
   WHERE id = v_tenure.id;
  -- Process overlap is cleared for every spawn under this tenure, uncertain
  -- and contradictory ones included: this evidence is about the whole tree,
  -- not one record. Effects stay on their commands, where an unknown outcome
  -- keeps holding the session.
  UPDATE public.session_turn_invocations i
     SET resolution = 'tree_quiescent',
         resolution_evidence_ref = COALESCE(
           p_evidence_ref, 'boot_changed:' || p_current_host_id || ':' || p_current_boot_id
         )
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.tenure_id = v_tenure.id
     AND i.session_id = g.session_id AND i.epoch = g.epoch
     AND i.resolution IS NULL;
  UPDATE public.session_turn_generations SET state = 'finished', finished_at = now(),
         finish_evidence = 'reconciled_' || p_evidence
   WHERE session_id = p_session_id AND tenure_id = v_tenure.id
     AND state IN ('active', 'recovery_required');
  RETURN jsonb_build_object('outcome', 'reconciled', 'tenureId', v_tenure.id);
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.record_session_admission_origin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.session_admission_mode_refusal(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_admission_mode_refusal(integer) TO service_role;
REVOKE ALL ON FUNCTION public.session_turn_unresolved_invocations(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_turn_unresolved_invocations(uuid, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.session_tenure_holder_refusal(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_tenure_holder_refusal(uuid, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_tenure(uuid, jsonb, text, text, jsonb, jsonb, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_turn(uuid, uuid, text, text, text, text, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_turn(uuid, uuid, text, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tenure(uuid, uuid, text, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.mark_tenure_lost(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tenure_lost(uuid, uuid, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, text, text, integer) TO service_role;
