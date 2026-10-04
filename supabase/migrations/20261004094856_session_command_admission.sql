-- Durable command admission, slice A (ink://specs/live-agent-surfaces R3/R4;
-- pr:701 eca1da3f, f59a705a, 83425b10).
--
-- DARK. Nothing calls these yet, no existing object changes, and the mode row
-- starts at 'legacy', in which admit_command and transition_command refuse with
-- mode_mismatch. session_dispatch_head is a read, not dispatch authority, and
-- is not mode-gated.
-- Owner tenure, turn generations and the running-write guard are deliberately
-- absent: their layout is still under review, and they land in later slices.
--
-- What this adds:
--   runtime_admission_mode     which admission protocol the database enforces.
--   session_commands           one durable record per admitted command, in one
--                              per-session order that admission assigns.
--   session_command_events     every state a command has been in, by revision.
--   session_command_receipts   who must hear about each revision, per recipient.
--   admit_command()            dedupe plus the per-session order: the contended
--                              invariant, so it is one transaction.
--   transition_command()       a CAS on (revision, state) that writes the
--                              command, its event and its receipts together.
--   session_dispatch_head()    the next command a turn may take, or the hold
--                              that stops it.

-- ── Mode ────────────────────────────────────────────────────────────────────
-- One row. A caller states the protocol it speaks, and a write refuses
-- whenever the row disagrees, so an old caller on a new database and a new
-- caller on an old one both stop instead of writing under the wrong rules.
-- Activation and rollback change this row inside a reviewed window.
CREATE TABLE public.runtime_admission_mode (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL CHECK (mode IN ('legacy', 'conditional')),
  protocol integer NOT NULL CHECK (protocol > 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_reason text NOT NULL
);

INSERT INTO public.runtime_admission_mode (mode, protocol, changed_reason)
VALUES ('legacy', 1, 'created dark; activation is a separate reviewed window');

-- ── Commands ────────────────────────────────────────────────────────────────
-- The nine command states are the canonical CommandState union (live-agent-
-- surfaces, "One command-state vocabulary"). A command has not started while
-- started_at is NULL; once set it never clears.
--
-- Rows are never deleted while their session exists. Retention removes the
-- payload and stamps tombstoned_at, so neither an admission_seq nor a dedupe
-- identity can be handed out twice.
--
-- An Inkmail command keeps two references to its message. source_message_ref
-- is the immutable identity (no foreign key, so deleting the message cannot
-- erase the dedupe key); source_message_id is the live link, nulled when the
-- message goes. A missing message makes a NOT-STARTED command rejectable; it
-- says nothing about one that may already have been delivered.
CREATE TABLE public.session_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user', 'sb', 'system')),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 200),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  payload_digest text NOT NULL CHECK (length(payload_digest) BETWEEN 1 AND 200),
  digest_version smallint NOT NULL CHECK (digest_version > 0),
  kind text NOT NULL CHECK (kind IN ('input.enqueue', 'session.compact')),
  origin_kind text NOT NULL
    CHECK (origin_kind IN ('terminal', 'browser', 'channel', 'inkmail', 'wake', 'internal')),
  origin_ref text CHECK (origin_ref IS NULL OR length(origin_ref) <= 200),
  addressee text CHECK (addressee IS NULL OR length(addressee) <= 200),
  payload jsonb,
  source_message_ref uuid,
  source_message_id uuid REFERENCES public.inbox_thread_messages(id) ON DELETE SET NULL,
  expected_turn text,
  admission_seq bigint NOT NULL CHECK (admission_seq > 0),
  state text NOT NULL CHECK (state IN (
    'stored', 'queued', 'waiting_for_consumer', 'backend_accepted', 'input_consumed',
    'completed', 'rejected', 'interrupted', 'unknown'
  )),
  -- Value-free codes only: never stderr, prompts or paths.
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_.:-]{1,100}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at timestamptz,
  executing_epoch text,
  -- An authorized recovery decision addresses one exact revision. If the
  -- command moves on, the decision no longer describes it and the hold returns.
  recovery_decided_at timestamptz,
  recovery_decided_revision integer,
  recovery_decision jsonb,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_commands_seq_unique UNIQUE (session_id, admission_seq),
  CONSTRAINT session_commands_identity_unique
    UNIQUE (workspace_id, principal_kind, principal_id, session_id, command_id),
  CONSTRAINT session_commands_inkmail_ref
    CHECK ((origin_kind = 'inkmail') = (source_message_ref IS NOT NULL)),
  -- An Inkmail body lives in its message; every other source has no other
  -- durable home, so it carries its payload until tombstoned.
  CONSTRAINT session_commands_payload_home CHECK (
    CASE
      WHEN tombstoned_at IS NOT NULL THEN payload IS NULL
      WHEN origin_kind = 'inkmail' THEN payload IS NULL
      ELSE payload IS NOT NULL
    END
  ),
  CONSTRAINT session_commands_decision_complete CHECK (
    (recovery_decided_at IS NULL AND recovery_decided_revision IS NULL AND recovery_decision IS NULL)
    OR (recovery_decided_at IS NOT NULL AND recovery_decided_revision IS NOT NULL
        AND recovery_decision IS NOT NULL)
  )
);

CREATE UNIQUE INDEX session_commands_inkmail_source_unique
  ON public.session_commands (session_id, source_message_ref)
  WHERE source_message_ref IS NOT NULL;

CREATE INDEX session_commands_not_started_idx
  ON public.session_commands (session_id, admission_seq)
  WHERE started_at IS NULL AND state IN ('stored', 'queued', 'waiting_for_consumer');

CREATE INDEX session_commands_started_open_idx
  ON public.session_commands (session_id, admission_seq)
  WHERE started_at IS NOT NULL AND state NOT IN ('completed', 'rejected', 'interrupted');

CREATE TRIGGER session_commands_updated_at
  BEFORE UPDATE ON public.session_commands
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.session_command_events (
  command_uuid uuid NOT NULL REFERENCES public.session_commands(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN (
    'stored', 'queued', 'waiting_for_consumer', 'backend_accepted', 'input_consumed',
    'completed', 'rejected', 'interrupted', 'unknown'
  )),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_.:-]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (command_uuid, revision)
);

-- One row per (revision, recipient): delivering it twice, or recording it
-- twice, is one receipt. A stored row is not evidence anyone saw it.
CREATE TABLE public.session_command_receipts (
  command_uuid uuid NOT NULL,
  revision integer NOT NULL,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('user', 'sb', 'operator')),
  recipient_id text NOT NULL CHECK (length(recipient_id) BETWEEN 1 AND 200),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (command_uuid, revision, recipient_kind, recipient_id),
  FOREIGN KEY (command_uuid, revision)
    REFERENCES public.session_command_events (command_uuid, revision) ON DELETE CASCADE
);

CREATE INDEX session_command_receipts_pending_idx
  ON public.session_command_receipts (created_at)
  WHERE delivered_at IS NULL;

-- Server-only, like every table the API owns: the service role bypasses RLS,
-- and no client role reads or writes these.
ALTER TABLE public.runtime_admission_mode ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_command_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_command_receipts ENABLE ROW LEVEL SECURITY;

-- ── Receipts helper ─────────────────────────────────────────────────────────
-- Every revision is owed to the command's originator (a user or SB), plus any
-- recipients the caller names. The functions below run with their caller's
-- rights, so the service role keeps EXECUTE; no client role has it.
CREATE FUNCTION public.session_command_record_receipts(
  p_command_uuid uuid,
  p_revision integer,
  p_principal_kind text,
  p_principal_id text,
  p_recipients jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_recipient jsonb;
BEGIN
  IF p_principal_kind IN ('user', 'sb') THEN
    INSERT INTO public.session_command_receipts (command_uuid, revision, recipient_kind, recipient_id)
    VALUES (p_command_uuid, p_revision, p_principal_kind, p_principal_id)
    ON CONFLICT DO NOTHING;
  END IF;
  FOR v_recipient IN SELECT * FROM jsonb_array_elements(COALESCE(p_recipients, '[]'::jsonb)) LOOP
    INSERT INTO public.session_command_receipts (command_uuid, revision, recipient_kind, recipient_id)
    VALUES (p_command_uuid, p_revision, v_recipient->>'kind', v_recipient->>'id')
    ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.session_command_record_receipts(uuid, integer, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_command_record_receipts(uuid, integer, text, text, jsonb)
  TO service_role;

-- Recipients arrive as [{ "kind": "user"|"sb"|"operator", "id": "..." }].
CREATE FUNCTION public.session_command_recipients_valid(p_recipients jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_recipients IS NULL OR (
    jsonb_typeof(p_recipients) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_recipients) r
       WHERE jsonb_typeof(r) <> 'object'
          OR (r->>'kind') IS NULL
          OR (r->>'kind') NOT IN ('user', 'sb', 'operator')
          OR length(COALESCE(r->>'id', '')) NOT BETWEEN 1 AND 200
    )
  )
$$;

REVOKE ALL ON FUNCTION public.session_command_recipients_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_command_recipients_valid(jsonb) TO service_role;

-- ── admit_command ───────────────────────────────────────────────────────────
-- Admits one command into its session's order, or returns the command that
-- already holds this identity. A repeat is the same command only if its whole
-- envelope is: digest, kind, principal, origin, addressee, expected turn and
-- message. Anything else under the same identity is a conflict, so a command
-- is never acknowledged to a caller who aimed it somewhere else. The envelope
-- is compared here, not only through the caller's digest.
--
-- It takes the session row FOR UPDATE: the same
-- lock turn admission will take, so assigning the next position and choosing
-- the head can never interleave. The caller has already resolved and
-- authorized the session (routing); this re-checks only that the session
-- belongs to the named workspace, and refuses otherwise.
--
-- 8 MiB matches the CLI drain's per-input bound (chat.ts maxPendingBytes), so
-- an input the terminal accepts is never refused here for size alone.
CREATE FUNCTION public.admit_command(
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
  PERFORM public.session_command_record_receipts(v_id, 1, p_principal_kind, p_principal_id, p_recipients);

  RETURN jsonb_build_object(
    'outcome', 'admitted', 'id', v_id, 'admissionSeq', v_seq, 'state', 'queued', 'revision', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admit_command(
  uuid, uuid, text, text, text, text, smallint, text, text, text, text, jsonb, uuid, text, jsonb, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_command(
  uuid, uuid, text, text, text, text, smallint, text, text, text, text, jsonb, uuid, text, jsonb, integer
) TO service_role;

-- ── transition_command ──────────────────────────────────────────────────────
-- Moves a command from the exact (revision, state) the caller read to a new
-- state, writing the command, its event and its receipts in one transaction.
--
-- What it refuses, whatever the caller believes:
--   * an expected revision or state that is missing or malformed: the CAS
--     compares both exactly, so a NULL can never match by falling through;
--   * leaving completed, rejected or interrupted;
--   * a started command returning to a not-started state, or being rejected:
--     it may already have been delivered, and only evidence can say otherwise;
--   * entering unknown without an operator recipient, whatever reason code the
--     caller gives. That write creates the recovery hold, or reinstates it over
--     a decision for an earlier revision, and the hold ships with the notice
--     that can end it or not at all. Ordinary in-flight serialization (a
--     handoff or acceptance waiting for its outcome) pages no one; when the
--     reconciler finds that outcome lost, it moves the command to unknown, and
--     that write carries the notice.
-- Entering backend_accepted, input_consumed, completed, interrupted or
-- unknown marks the command started. p_mark_started records a handoff before
-- any outcome exists: a write to the command's current not-started state that
-- only stamps started_at. From then on the command holds later ordinary work
-- until terminal evidence or a recovery decision (session_dispatch_head), so a
-- status write that is lost after the handoff can never read as safe.
CREATE FUNCTION public.transition_command(
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
  PERFORM public.session_command_record_receipts(
    p_command_uuid, v_revision, v_command.principal_kind, v_command.principal_id, p_recipients
  );

  RETURN jsonb_build_object('outcome', 'transitioned', 'revision', v_revision, 'state', p_new_state);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_command(
  uuid, integer, text, text, text, boolean, text, jsonb, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_command(
  uuid, integer, text, text, text, boolean, text, jsonb, integer
) TO service_role;

-- ── session_dispatch_head ───────────────────────────────────────────────────
-- What the next ordinary turn may take: the lowest not-started command, unless
-- a started command has no terminal outcome and no recovery decision recorded
-- for its current revision. Then later ordinary work waits (live-agent-surfaces
-- v29 R3), and this names the command holding it:
--   recovery_required    its outcome is unknown. Actionable: every write into
--                        unknown carried an operator notice (transition_command).
--   unresolved_dispatch  it was handed off or accepted and nothing terminal has
--                        been recorded since. Ordinary in-flight serialization,
--                        which pages no one; it is also what a lost status
--                        write looks like, until the reconciler finds it lost
--                        and moves the command to unknown with the notice.
-- The hold is computed from the commands themselves, never from a flag that a
-- lost write could leave unset. Process quiescence does not lift it; only
-- terminal evidence or a decision addressing that exact revision does.
--
-- A read, not dispatch authority, so it is not mode-gated: turn admission
-- re-checks under the session lock.
CREATE FUNCTION public.session_dispatch_head(p_session_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN hold.id IS NOT NULL THEN
      jsonb_build_object(
        'hold', CASE WHEN hold.state = 'unknown' THEN 'recovery_required' ELSE 'unresolved_dispatch' END,
        'holdingCommand', hold.id,
        'head', NULL
      )
    ELSE
      jsonb_build_object('hold', NULL, 'holdingCommand', NULL, 'head', head.id)
  END
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT c.id, c.state FROM public.session_commands c
     WHERE c.session_id = p_session_id
       AND c.started_at IS NOT NULL
       AND c.state NOT IN ('completed', 'rejected', 'interrupted')
       AND c.recovery_decided_revision IS DISTINCT FROM c.revision
     ORDER BY c.admission_seq
     LIMIT 1
  ) AS hold ON true
  LEFT JOIN LATERAL (
    SELECT c.id FROM public.session_commands c
     WHERE c.session_id = p_session_id
       AND c.started_at IS NULL
       AND c.state IN ('stored', 'queued', 'waiting_for_consumer')
     ORDER BY c.admission_seq
     LIMIT 1
  ) AS head ON true
$$;

REVOKE ALL ON FUNCTION public.session_dispatch_head(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_dispatch_head(uuid) TO service_role;
