-- Session journal, slice D1 (ink://specs/live-agent-surfaces v44 D1a; pr:701
-- 7cf85abb, contract b9beb65d, Lumen's correction 9c5f3502).
--
-- DARK, like slices A, A2 and C1: no code path creates a journaled session,
-- and every function refuses with mode_mismatch unless runtime_admission_mode
-- is 'conditional' at the caller's protocol.
--
-- The journal is the canonical record of a hosted session's runtime events. A
-- DB lineage is a session created with journal_kind 'db_v1': its header opens
-- in that same INSERT, so no history can predate it, and nothing can give an
-- existing session one later. The kind selects the lineage. Every function
-- here that meets it requires the matching header and refuses without it; none
-- falls back to the legacy path because a header is missing.
--
-- One append is one transaction: validation, the entry, its projection into
-- session_turn_invocations (the admission index) and the head advance commit
-- together or not at all. Every refusal is returned as data and writes
-- nothing, except the set-only capacity hold, which is itself the refusal.
--
-- The seal. ink_admission_writer, a NOLOGIN role, owns the invocation index
-- and both journal tables. No API role can write them: service_role keeps
-- SELECT, and anon and authenticated keep nothing. Only the definer functions
-- listed under "Ownership and grants", and the one reducer behind them, change
-- these tables. That seals the projector. It does NOT stop service_role from
-- forging authority itself: tenures, generations, origins and
-- sessions.owner_tenure_id stay directly writable, as in A2, and a compared
-- capability hash is bearer-equivalent. Sealing those is its own slice,
-- required before activation.
--
-- Lock order, unchanged from A2: the sessions row, then the journal header,
-- then rows of the admission tables.

-- ── The writer role ─────────────────────────────────────────────────────────
-- BYPASSRLS because the tables its functions read (sessions, tenures,
-- generations, the mode row) have row security on and no policies; its reach
-- is exactly the grants below. Roles outlive a database reset, so an existing
-- role is brought back to these attributes and to postgres as its only member
-- rather than trusted.
DO $$
DECLARE
  v_member record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ink_admission_writer') THEN
    CREATE ROLE ink_admission_writer NOLOGIN NOINHERIT BYPASSRLS;
  ELSE
    ALTER ROLE ink_admission_writer NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  FOR v_member IN
    SELECT m.rolname
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = am.member
     WHERE r.rolname = 'ink_admission_writer' AND m.rolname <> 'postgres'
  LOOP
    EXECUTE format('REVOKE ink_admission_writer FROM %I', v_member.rolname);
  END LOOP;
END
$$;

-- Migrations and fixture cleanup act as the owner through this membership.
GRANT ink_admission_writer TO postgres;

-- An unexposed schema for the reducer and its helpers: PostgREST serves
-- public, storage and graphql_public only, and nobody but the writer may use
-- this one. CREATE on both schemas lasts only until ownership is settled at
-- the end of this file.
CREATE SCHEMA ink_admission;
REVOKE ALL ON SCHEMA ink_admission FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA ink_admission TO ink_admission_writer;
GRANT CREATE ON SCHEMA public TO ink_admission_writer;

-- ── The lineage marker ──────────────────────────────────────────────────────
-- Chosen in the INSERT that creates the session and fixed from then on.
ALTER TABLE public.sessions ADD COLUMN journal_kind text
  CONSTRAINT sessions_journal_kind_known CHECK (journal_kind IS NULL OR journal_kind = 'db_v1');

-- ── Journal tables ──────────────────────────────────────────────────────────
-- The header carries no owner, lease or capability: the sessions row and its
-- tenure remain the authority. committed_eid starts at zero and only ever
-- advances by one, in the transaction that inserts that entry.
CREATE TABLE public.session_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES public.sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'db_v1'),
  committed_eid bigint NOT NULL DEFAULT 0 CHECK (committed_eid BETWEEN 0 AND 9007199254740991),
  committed_bytes bigint NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
  -- Stored entry bytes this lineage may hold before it stops (512 MiB).
  byte_budget bigint NOT NULL DEFAULT 536870912 CHECK (byte_budget > 0),
  -- Set once, never cleared or overwritten in this slice: only an authorized
  -- reconciliation, which does not exist yet, could clear it.
  hold_reason text CHECK (hold_reason IS NULL OR hold_reason ~ '^[a-z0-9_.:-]{1,100}$'),
  held_at timestamptz,
  held_by_tenure_id uuid,
  held_by_host_instance_id text
    CHECK (held_by_host_instance_id IS NULL OR length(held_by_host_instance_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_journals_hold_fields CHECK (
    (hold_reason IS NULL) = (held_at IS NULL)
    AND (hold_reason IS NULL) = (held_by_tenure_id IS NULL)
    AND (hold_reason IS NULL) = (held_by_host_instance_id IS NULL)
  )
);

-- One row per committed entry, never updated after its transaction and never
-- reused. entry is the exact shared envelope (all ten fields, ts as the
-- writer's string). entry_bytes is the size of Postgres's jsonb text, which
-- is what PostgREST sends for the column: never below the host's compact
-- size. 512 KiB here against the host's 256 KiB compact cap keeps one entry
-- inside any 1 MiB read page.
CREATE TABLE public.session_journal_entries (
  journal_id uuid NOT NULL REFERENCES public.session_journals(id) ON DELETE CASCADE,
  eid bigint NOT NULL CHECK (eid BETWEEN 1 AND 9007199254740991),
  entry jsonb NOT NULL,
  -- Derived, never written: no caller, admin or restore can make it disagree
  -- with the row it measures.
  entry_bytes integer GENERATED ALWAYS AS (octet_length(entry::text)) STORED
    CHECK (entry_bytes BETWEEN 2 AND 524288),
  projection text NOT NULL
    CHECK (projection IN ('none', 'recorded', 'already_recorded', 'contradiction', 'needs_reconciler')),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journal_id, eid),
  CONSTRAINT session_journal_entries_envelope CHECK (
    jsonb_typeof(entry) = 'object'
    AND entry->>'journalId' = journal_id::text
    AND entry->>'eid' = eid::text
  )
);

ALTER TABLE public.session_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_journal_entries ENABLE ROW LEVEL SECURITY;

-- ── Opening a journal ───────────────────────────────────────────────────────
-- Only in the creating INSERT, and only where A2 would record a never-owned
-- origin: conditional mode, no turn, no provider session. A creator that asks
-- for a journal it cannot have gets an error, never a quiet legacy session.
CREATE FUNCTION public.session_journal_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.turn_epoch IS NOT NULL
     OR NEW.backend_session_id IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.runtime_admission_mode WHERE singleton AND mode = 'conditional'
     ) THEN
    RAISE EXCEPTION 'a session journal opens only on a fresh session created in conditional mode'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.session_journals (session_id, kind) VALUES (NEW.id, NEW.journal_kind);
  RETURN NULL;
END;
$$;

CREATE TRIGGER session_journal_open
  AFTER INSERT ON public.sessions
  FOR EACH ROW
  WHEN (NEW.journal_kind IS NOT NULL)
  EXECUTE FUNCTION public.session_journal_open();

CREATE FUNCTION public.session_journal_kind_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'sessions.journal_kind is fixed when the session is created'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER session_journal_kind_immutable
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (OLD.journal_kind IS DISTINCT FROM NEW.journal_kind)
  EXECUTE FUNCTION public.session_journal_kind_immutable();

-- ── The lineage gate ────────────────────────────────────────────────────────
-- Read with the sessions row already locked. A session with neither a kind
-- nor a header is legacy. One with either is a DB lineage, and is usable only
-- when both are present and agree: a header missing under a db_v1 kind, or a
-- header under no kind (restored or damaged data), is refused as
-- journal_missing by every path, never treated as legacy.
CREATE FUNCTION public.session_journal_gate(p_session_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN s.journal_kind IS NULL AND j.id IS NULL THEN jsonb_build_object('journaled', false)
    WHEN s.journal_kind IS DISTINCT FROM 'db_v1' OR j.id IS NULL OR j.kind IS DISTINCT FROM s.journal_kind
      THEN jsonb_build_object(
        'journaled', true, 'refusal', jsonb_build_object('outcome', 'journal_missing')
      )
    ELSE jsonb_build_object('journaled', true, 'journalId', j.id, 'hold', j.hold_reason)
  END
  FROM public.sessions s
  LEFT JOIN public.session_journals j ON j.session_id = s.id
  WHERE s.id = p_session_id
$$;

-- ── Entry validation ────────────────────────────────────────────────────────
-- The database's own check of the shared envelope (journal-record.ts), so a
-- projection never rests on the host's validation alone. Helpers first.
CREATE FUNCTION ink_admission.journal_keys_are(p_value jsonb, p_keys text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'object' THEN
    ARRAY(SELECT k FROM jsonb_object_keys(p_value) AS k ORDER BY k COLLATE "C")
      = ARRAY(SELECT k FROM unnest(p_keys) AS k ORDER BY k COLLATE "C")
  ELSE false END
$$;

CREATE FUNCTION ink_admission.journal_string_matches(p_value jsonb, p_pattern text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'string' THEN (p_value #>> '{}') ~ p_pattern ELSE false END
$$;

CREATE FUNCTION ink_admission.journal_pid_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'number'
    THEN public.session_admission_valid_pid(p_value #>> '{}') ELSE false END
$$;

-- A positive integer in JavaScript's safe range, or NULL.
CREATE FUNCTION ink_admission.journal_eid(p_value jsonb)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_value) = 'number' AND (p_value #>> '{}') ~ '^[1-9][0-9]{0,15}$'
         AND (p_value #>> '{}')::bigint <= 9007199254740991
      THEN (p_value #>> '{}')::bigint
  END
$$;

-- Millisecond UTC ISO text that names a real instant and prints back the same.
CREATE FUNCTION ink_admission.journal_ts_valid(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_text text;
BEGIN
  IF NOT ink_admission.journal_string_matches(
    p_value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) THEN
    RETURN false;
  END IF;
  v_text := p_value #>> '{}';
  RETURN to_char(v_text::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = v_text;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

-- NULL when the entry is a well-formed record of this journal at the next
-- eid; otherwise invalid_entry or entry_too_large. Authority is not checked
-- here: the writer tenure is compared with the holder after the lock.
CREATE FUNCTION ink_admission.journal_entry_refusal(
  p_entry jsonb,
  p_session_id uuid,
  p_host_instance_id text,
  p_journal_id uuid,
  p_expected_committed_eid bigint
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  c_id constant text := '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$';
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_reason constant text := '^[a-z0-9_.:-]{1,100}$';
  v_type text;
  v_target jsonb;
  v_body jsonb;
  v_part jsonb;
  v_spawn boolean;
  v_negative boolean;
BEGIN
  IF p_entry IS NULL OR jsonb_typeof(p_entry) IS DISTINCT FROM 'object'
     OR p_session_id IS NULL OR p_journal_id IS NULL OR p_host_instance_id IS NULL
     OR p_expected_committed_eid IS NULL
     OR p_expected_committed_eid NOT BETWEEN 0 AND 9007199254740990 THEN
    RETURN 'invalid_entry';
  END IF;
  IF octet_length(p_entry::text) > 524288 THEN
    RETURN 'entry_too_large';
  END IF;
  v_type := p_entry->>'type';
  v_target := p_entry->'target';
  v_body := p_entry->'body';
  IF NOT COALESCE(
    ink_admission.journal_keys_are(p_entry, ARRAY[
      'version', 'journalId', 'sessionId', 'writerTenureId', 'hostInstanceId',
      'eid', 'ts', 'type', 'target', 'body'
    ])
    AND p_entry->'version' = '1'::jsonb
    AND ink_admission.journal_string_matches(p_entry->'journalId', c_uuid)
    AND p_entry->>'journalId' = p_journal_id::text
    AND ink_admission.journal_string_matches(p_entry->'sessionId', c_uuid)
    AND p_entry->>'sessionId' = p_session_id::text
    AND ink_admission.journal_string_matches(p_entry->'writerTenureId', c_uuid)
    AND ink_admission.journal_string_matches(p_entry->'hostInstanceId', c_id)
    AND p_entry->>'hostInstanceId' = p_host_instance_id
    AND ink_admission.journal_eid(p_entry->'eid') = p_expected_committed_eid + 1
    AND ink_admission.journal_ts_valid(p_entry->'ts')
    AND ink_admission.journal_string_matches(p_entry->'type', c_id)
    AND jsonb_typeof(v_body) = 'object'
    AND NOT v_body ?| ARRAY[
      'eid', 'ts', 'type', 'version', 'journalId', 'sessionId', 'writerTenureId',
      'hostInstanceId', 'target', 'body'
    ], false) THEN
    RETURN 'invalid_entry';
  END IF;

  v_spawn := v_type IN ('provider_spawn_intent', 'provider_spawn_binding', 'provider_spawn_observation');
  IF v_type LIKE 'provider\_spawn\_%' AND NOT v_spawn THEN
    RETURN 'invalid_entry';
  END IF;
  -- Only negative evidence may name a turn of another tenure.
  v_negative := v_type = 'provider_spawn_observation'
    AND v_body->'kind' IN ('"unknown"'::jsonb, '"child_alive"'::jsonb, '"contradiction"'::jsonb);
  IF jsonb_typeof(v_target) = 'null' THEN
    IF v_spawn THEN
      RETURN 'invalid_entry';
    END IF;
  ELSIF NOT COALESCE(
    ink_admission.journal_keys_are(v_target, ARRAY['tenureId', 'epoch', 'commandUuid', 'invocationId'])
    AND ink_admission.journal_string_matches(v_target->'tenureId', c_uuid)
    AND ink_admission.journal_string_matches(v_target->'epoch', c_id)
    AND ink_admission.journal_string_matches(v_target->'commandUuid', c_uuid)
    AND (jsonb_typeof(v_target->'invocationId') = 'null'
         OR ink_admission.journal_string_matches(v_target->'invocationId', c_id))
    AND NOT (v_spawn AND jsonb_typeof(v_target->'invocationId') = 'null')
    AND (v_negative OR v_target->>'tenureId' = p_entry->>'writerTenureId'), false) THEN
    RETURN 'invalid_entry';
  END IF;

  IF v_type = 'provider_spawn_intent' THEN
    v_part := v_body->'execution';
    IF NOT COALESCE(
      ink_admission.journal_keys_are(v_body, ARRAY['adapter', 'hostMode', 'attemptId', 'deadlineAt', 'execution'])
      AND jsonb_typeof(v_body->'adapter') = 'string'
      AND v_body->>'adapter' IN ('claude-code', 'codex-cli', 'ink', 'gemini', 'antigravity')
      AND jsonb_typeof(v_body->'hostMode') = 'string'
      AND v_body->>'hostMode' IN ('server_hosted', 'interactive_wrapper', 'native_external')
      AND (jsonb_typeof(v_body->'attemptId') = 'null'
           OR ink_admission.journal_string_matches(v_body->'attemptId', c_id))
      AND (jsonb_typeof(v_body->'deadlineAt') = 'null'
           OR ink_admission.journal_ts_valid(v_body->'deadlineAt'))
      AND ((ink_admission.journal_keys_are(v_part, ARRAY['kind', 'hostId', 'bootId'])
            AND v_part->'kind' = '"known"'::jsonb
            AND ink_admission.journal_string_matches(v_part->'hostId', c_id)
            AND ink_admission.journal_string_matches(v_part->'bootId', c_id))
        OR (ink_admission.journal_keys_are(v_part, ARRAY['kind', 'reasonCode'])
            AND v_part->'kind' = '"unverified"'::jsonb
            AND ink_admission.journal_string_matches(v_part->'reasonCode', c_reason))), false) THEN
      RETURN 'invalid_entry';
    END IF;
  ELSIF v_type = 'provider_spawn_binding' THEN
    v_part := v_body->'containment';
    IF NOT COALESCE(
      (ink_admission.journal_keys_are(v_body, ARRAY['kind', 'pid', 'startIdentity', 'containment'])
       AND v_body->'kind' = '"process_binding"'::jsonb
       AND ink_admission.journal_pid_valid(v_body->'pid')
       AND ink_admission.journal_string_matches(v_body->'startIdentity', c_id)
       AND ((ink_admission.journal_keys_are(v_part, ARRAY['kind'])
             AND v_part->'kind' = '"unknown"'::jsonb)
         OR (ink_admission.journal_keys_are(v_part, ARRAY['kind', 'pgid', 'evidenceRef'])
             AND v_part->'kind' = '"process_group"'::jsonb
             AND ink_admission.journal_pid_valid(v_part->'pgid')
             AND ink_admission.journal_string_matches(v_part->'evidenceRef', c_id))
         OR (ink_admission.journal_keys_are(v_part, ARRAY['kind', 'identity', 'evidenceRef'])
             AND v_part->'kind' = '"attested_tree"'::jsonb
             AND ink_admission.journal_string_matches(v_part->'identity', c_id)
             AND ink_admission.journal_string_matches(v_part->'evidenceRef', c_id))))
      OR (ink_admission.journal_keys_are(v_body, ARRAY['kind', 'providerTranscriptId'])
          AND v_body->'kind' = '"transcript_binding"'::jsonb
          AND ink_admission.journal_string_matches(v_body->'providerTranscriptId', c_id)), false) THEN
      RETURN 'invalid_entry';
    END IF;
  ELSIF v_type = 'provider_spawn_observation' THEN
    IF NOT COALESCE(
      (ink_admission.journal_keys_are(v_body, ARRAY['kind', 'reasonCode'])
       AND v_body->'kind' = '"unknown"'::jsonb
       AND ink_admission.journal_string_matches(v_body->'reasonCode', c_reason))
      OR (ink_admission.journal_keys_are(v_body, ARRAY['kind', 'evidenceRef'])
          AND jsonb_typeof(v_body->'kind') = 'string'
          AND v_body->>'kind' IN (
            'parent_exited', 'group_empty', 'tree_quiescent', 'not_spawned', 'child_alive', 'contradiction'
          )
          AND ink_admission.journal_string_matches(v_body->'evidenceRef', c_id)), false) THEN
      RETURN 'invalid_entry';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- NULL when the entry's target names this session's own record of that turn:
-- the generation exists under the named tenure and command. A new ordinary
-- event also needs it to be the writer's active turn, and a named invocation
-- to exist. An exact retry is checked for that correlation only, since its
-- turn may have finished since it committed.
CREATE FUNCTION ink_admission.journal_target_refusal(
  p_session_id uuid,
  p_writer_tenure_id uuid,
  p_entry jsonb,
  p_retry boolean
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_target jsonb := p_entry->'target';
  v_gen record;
BEGIN
  IF jsonb_typeof(v_target) = 'null' THEN
    RETURN NULL;
  END IF;
  SELECT g.tenure_id, g.command_uuid, g.state INTO v_gen
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.epoch = v_target->>'epoch';
  IF NOT FOUND
     OR v_gen.tenure_id::text IS DISTINCT FROM v_target->>'tenureId'
     OR v_gen.command_uuid::text IS DISTINCT FROM v_target->>'commandUuid' THEN
    RETURN 'stale_target';
  END IF;
  IF p_entry->>'type' NOT IN ('provider_spawn_intent', 'provider_spawn_binding', 'provider_spawn_observation') THEN
    IF NOT p_retry AND (v_gen.state <> 'active' OR v_gen.tenure_id <> p_writer_tenure_id) THEN
      RETURN 'stale_target';
    END IF;
    IF v_target->>'invocationId' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.session_turn_invocations i
       WHERE i.session_id = p_session_id AND i.epoch = v_target->>'epoch'
         AND i.invocation_id = v_target->>'invocationId'
    ) THEN
      RETURN 'stale_target';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- What a spawn entry asserts about one invocation, in record_invocation's
-- terms: its turn, its identity, the kind and the detail the reducer reads.
-- NULL for an ordinary entry, which projects nothing.
CREATE FUNCTION ink_admission.invocation_record(p_entry jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_entry->>'type'
    WHEN 'provider_spawn_intent' THEN jsonb_build_object('kind', 'intent', 'detail', '{}'::jsonb)
    WHEN 'provider_spawn_binding' THEN CASE p_entry->'body'->>'kind'
      WHEN 'process_binding' THEN jsonb_build_object(
        'kind', 'process_binding',
        'detail', jsonb_build_object(
          'pid', p_entry->'body'->'pid', 'startIdentity', p_entry->'body'->'startIdentity'
        )
      )
      ELSE jsonb_build_object(
        'kind', 'transcript_binding',
        'detail', jsonb_build_object('providerTranscriptId', p_entry->'body'->'providerTranscriptId')
      )
    END
    WHEN 'provider_spawn_observation' THEN jsonb_build_object(
      'kind', p_entry->'body'->>'kind', 'detail', (p_entry->'body') - 'kind'
    )
  END || jsonb_build_object(
    'epoch', p_entry->'target'->'epoch', 'invocationId', p_entry->'target'->'invocationId'
  )
$$;

-- ── The reducer ─────────────────────────────────────────────────────────────
-- record_invocation's projection, extracted unchanged so the legacy wrapper
-- and the journal append share one implementation. Two additions, both
-- negative: child_alive, which contradicts a resolution and otherwise leaves
-- an already-open obligation as it is, and an explicit contradiction.
--
-- Callers hold the sessions row and have authenticated the writer as its
-- current holder. The session's lineage, never the caller, decides the path:
-- a DB lineage projects only the canonical entry this transaction inserted at
-- head+1, and only what that entry says; a legacy one takes explicit records
-- and no entry reference. Negative evidence on a DB lineage may reach a turn
-- of any tenure, because it can only reopen an obligation. Everything else,
-- and every legacy record, stays on the writer's own turns.
CREATE FUNCTION ink_admission.reduce_invocation(
  p_session_id uuid,
  p_writer_tenure_id uuid,
  p_epoch text,
  p_invocation_id text,
  p_kind text,
  p_detail jsonb,
  p_journal_id uuid,
  p_eid bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_gate jsonb;
  v_journaled boolean;
  v_head bigint;
  v_entry jsonb;
  v_gen record;
  v_inv record;
  v_pid integer;
  v_start text := p_detail->>'startIdentity';
  v_transcript text := p_detail->>'providerTranscriptId';
  v_ref text := p_detail->>'evidenceRef';
  v_reason text := p_detail->>'reasonCode';
  v_contradiction boolean := false;
BEGIN
  v_gate := public.session_journal_gate(p_session_id);
  v_journaled := COALESCE((v_gate->>'journaled')::boolean, true);
  IF v_journaled THEN
    SELECT j.committed_eid INTO v_head
      FROM public.session_journals j
     WHERE j.id = p_journal_id AND j.session_id = p_session_id;
    SELECT e.entry INTO v_entry
      FROM public.session_journal_entries e
     WHERE e.journal_id = p_journal_id AND e.eid = p_eid;
    IF v_gate ? 'refusal' OR (v_gate->>'journalId')::uuid IS DISTINCT FROM p_journal_id
       OR v_head IS NULL OR p_eid IS DISTINCT FROM v_head + 1 OR v_entry IS NULL
       OR v_entry->>'writerTenureId' IS DISTINCT FROM p_writer_tenure_id::text
       OR ink_admission.invocation_record(v_entry) IS DISTINCT FROM jsonb_build_object(
            'epoch', p_epoch, 'invocationId', p_invocation_id, 'kind', p_kind, 'detail', p_detail
          ) THEN
      RAISE EXCEPTION 'reduce_invocation: no canonical journal entry for this projection'
        USING ERRCODE = 'IJ002';
    END IF;
  ELSIF p_journal_id IS NOT NULL OR p_eid IS NOT NULL THEN
    RAISE EXCEPTION 'reduce_invocation: an entry reference on a legacy lineage'
      USING ERRCODE = 'IJ002';
  END IF;

  SELECT g.state, g.tenure_id INTO v_gen
    FROM public.session_turn_generations g
   WHERE g.session_id = p_session_id AND g.epoch = p_epoch;
  IF NOT FOUND OR (
    v_gen.tenure_id IS DISTINCT FROM p_writer_tenure_id
    AND NOT (v_journaled AND p_kind IN ('unknown', 'child_alive', 'contradiction'))
  ) THEN
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
    IF v_gen.state <> 'active' THEN
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
  ELSIF p_kind = 'child_alive' THEN
    -- A process of this spawn is alive: a resolution was wrong. Unresolved, it
    -- is an obligation already open, and the record changes nothing here.
    IF v_inv.resolution IS NOT NULL THEN
      v_contradiction := true;
    ELSE
      RETURN jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
    END IF;
  ELSIF p_kind = 'contradiction' THEN
    v_contradiction := true;
  ELSIF p_kind = 'process_binding' THEN
    v_pid := (p_detail->>'pid')::integer;
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

-- ── record_invocation, the legacy wrapper ───────────────────────────────────
-- A2's validation and authority, unchanged, in front of the shared reducer. A
-- DB lineage is refused: it records only through its journal, whatever state
-- its header is in.
CREATE OR REPLACE FUNCTION public.record_invocation(
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
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

-- ── reconcile_tenure, behind a lineage check ────────────────────────────────
-- A2's body moves unchanged into the private schema. The public entry point
-- refuses a DB lineage, which needs a reconciler that appends canonical
-- evidence (not in this slice), and hands every other call to it.
ALTER FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  RENAME TO reconcile_tenure_legacy;
ALTER FUNCTION public.reconcile_tenure_legacy(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  SET SCHEMA ink_admission;
ALTER FUNCTION ink_admission.reconcile_tenure_legacy(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  SET search_path = '';

CREATE FUNCTION public.reconcile_tenure(
  p_session_id uuid,
  p_expected_tenure_id uuid,
  p_evidence text,
  p_current_boot_id text,
  p_current_host_id text,
  p_evidence_ref text,
  p_expected_legacy jsonb,
  p_authority text,
  p_host_instance_id text,
  p_protocol integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_refusal jsonb;
BEGIN
  v_refusal := public.session_admission_mode_refusal(p_protocol);
  IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
  PERFORM 1 FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF FOUND AND (public.session_journal_gate(p_session_id)->>'journaled')::boolean THEN
    RETURN jsonb_build_object('outcome', 'refused', 'reason', 'journal_lineage_needs_journal_reconciler');
  END IF;
  RETURN ink_admission.reconcile_tenure_legacy(
    p_session_id, p_expected_tenure_id, p_evidence, p_current_boot_id, p_current_host_id,
    p_evidence_ref, p_expected_legacy, p_authority, p_host_instance_id, p_protocol
  );
END;
$$;

-- ── Admission, registration and release on a DB lineage ─────────────────────
-- A2's bodies with three additions, each for DB lineages only: the lineage
-- gate after the session lock, unresolved spawns counted across every tenure
-- the session has had (register and release counted only one), and a held
-- journal refusing before the dispatch head is read. admit_leased_turn admits
-- through admit_turn and returns its refusals unchanged.

CREATE OR REPLACE FUNCTION public.register_tenure(
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
  IF p_capability_hash IS NULL OR p_capability_hash !~ '^sha256:[0-9a-f]{64}$' THEN
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
    p_session_id, p_mode, 'held', p_capability_hash, p_host->>'instanceId', p_host->>'bootId',
    p_host->>'hostId', (p_owner->>'pid')::integer, p_owner->>'startIdentity', p_endpoint
  )
  RETURNING id INTO v_id;

  UPDATE public.sessions SET owner_tenure_id = v_id WHERE id = p_session_id;

  RETURN jsonb_build_object('outcome', 'registered', 'tenureId', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admit_turn(
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
  v_journal jsonb;
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

CREATE OR REPLACE FUNCTION public.release_tenure(
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
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

-- ── append_session_journal ──────────────────────────────────────────────────
-- The holder commits one entry at the next eid, or proves an exact earlier
-- commit. The reply is exactly the shared JournalCommitReceipt, or
-- {outcome: 'refused', reasonCode}. Checks run in the order below, and the
-- first that fails is the reply:
--   mode_mismatch, invalid_entry, entry_too_large (before any lock);
--   session_missing, not_holder, stale_writer, journal_missing (under the
--   sessions lock; the holder is checked before any retry is answered);
--   conflict, or already_committed for an exact retry (under the header lock);
--   head_mismatch, journal_held, capacity_held, stale_target;
--   no_intent, stale_target, invalid_entry from the projection, which roll the
--   entry back.
-- A receipt is evidence of a commit, never permission to dispatch.
CREATE FUNCTION public.append_session_journal(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
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

-- ── hold_session_journal ────────────────────────────────────────────────────
-- Set-only, under the same authority, and possible at capacity: it writes no
-- entry. An existing reason is never overwritten. The reply echoes the reason
-- asked for once a hold is proven to stand, as the writer expects; the first
-- reason stays on the header.
CREATE FUNCTION public.hold_session_journal(
  p_session_id uuid,
  p_tenure_id uuid,
  p_capability_hash text,
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
    p_session_id, p_tenure_id, p_capability_hash, p_host_instance_id
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

-- ── Ownership and grants ────────────────────────────────────────────────────
-- Sealed: the invocation index and both journal tables belong to the writer.
-- A change of owner keeps the default-ACL grants (measured), so every API
-- role's privileges are revoked explicitly and only service_role's SELECT is
-- given back. Without ownership, service_role cannot disable their triggers.
ALTER TABLE public.session_turn_invocations OWNER TO ink_admission_writer;
ALTER TABLE public.session_journals OWNER TO ink_admission_writer;
ALTER TABLE public.session_journal_entries OWNER TO ink_admission_writer;
REVOKE ALL ON TABLE public.session_turn_invocations, public.session_journals,
  public.session_journal_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.session_turn_invocations, public.session_journals,
  public.session_journal_entries TO service_role;

-- No behavior change: the browser roles' default-ACL grants on A2's other
-- tables (row security already refused them everything but TRUNCATE).
REVOKE ALL ON TABLE public.session_admission_origins, public.session_owner_tenures,
  public.session_turn_generations FROM anon, authenticated;

-- What the writer's functions read and write outside the sealed tables:
-- sessions to lock (FOR UPDATE needs an UPDATE privilege) and for
-- reconcile's owner pointer; tenures and generations for reconcile's legacy
-- path; the mode row.
GRANT SELECT ON TABLE public.sessions TO ink_admission_writer;
GRANT UPDATE (owner_tenure_id) ON TABLE public.sessions TO ink_admission_writer;
GRANT SELECT, INSERT, UPDATE ON TABLE public.session_owner_tenures,
  public.session_turn_generations TO ink_admission_writer;
GRANT SELECT ON TABLE public.runtime_admission_mode TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_admission_mode_refusal(integer) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_tenure_holder_refusal(uuid, uuid, text, text) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_admission_valid_pid(text) TO ink_admission_writer;
GRANT EXECUTE ON FUNCTION public.session_legacy_state(public.sessions) TO ink_admission_writer;

-- The definer allowlist: the only functions that run as the writer.
ALTER FUNCTION public.session_journal_open() OWNER TO ink_admission_writer;
ALTER FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer)
  OWNER TO ink_admission_writer;
ALTER FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer)
  OWNER TO ink_admission_writer;
ALTER FUNCTION public.record_invocation(uuid, uuid, text, text, text, text, text, jsonb, integer)
  OWNER TO ink_admission_writer;
ALTER FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  OWNER TO ink_admission_writer;

-- The private helpers, invoker functions only ever reached from a definer.
ALTER FUNCTION ink_admission.journal_keys_are(jsonb, text[]) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_string_matches(jsonb, text) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_pid_valid(jsonb) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_eid(jsonb) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_ts_valid(jsonb) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_entry_refusal(jsonb, uuid, text, uuid, bigint) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.journal_target_refusal(uuid, uuid, jsonb, boolean) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.invocation_record(jsonb) OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.reduce_invocation(uuid, uuid, text, text, text, jsonb, uuid, bigint)
  OWNER TO ink_admission_writer;
ALTER FUNCTION ink_admission.reconcile_tenure_legacy(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  OWNER TO ink_admission_writer;

-- Execution. New functions carry the global PUBLIC grant and public's
-- default ACL; each is revoked and only the intended callers are granted.
REVOKE ALL ON FUNCTION ink_admission.journal_keys_are(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_string_matches(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_pid_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_eid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_ts_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_entry_refusal(jsonb, uuid, text, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.journal_target_refusal(uuid, uuid, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.invocation_record(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.reduce_invocation(uuid, uuid, text, text, text, jsonb, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ink_admission.reconcile_tenure_legacy(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.session_journal_open() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.session_journal_kind_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.session_journal_gate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_journal_gate(uuid) TO service_role, ink_admission_writer;
REVOKE ALL ON FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_tenure(uuid, uuid, text, text, text, text, jsonb, text, text, integer)
  TO service_role;

-- Ownership is settled: the writer creates nothing from here on.
REVOKE CREATE ON SCHEMA public FROM ink_admission_writer;
REVOKE CREATE ON SCHEMA ink_admission FROM ink_admission_writer;
