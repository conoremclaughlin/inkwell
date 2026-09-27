"""Scoped fixture cleanup, usable only inside an identity-checked test container.

No host connection URL is accepted. PostgreSQL's generic database name is NOT
the isolation boundary: the exact Supabase container identity is also required.
"""

import hashlib
import json
import re
import subprocess
import uuid


class Refusal(Exception):
    pass


DATABASE = "postgres"
BASELINE_FILE = "fixture-baseline.sql"
# Explicit application fixture tables, including their FK/history dependants.
# Never discover a broader cleanup scope from pg_tables or use CASCADE. A new
# dependency outside this list must fail RESTRICT and be reviewed explicitly.
# Auth/storage/extension/migration schemas, pcp_config and permission_definitions
# are deliberately not reset. The baseline preserves migration-seeded templates.
FIXTURE_TABLES = tuple("""
activity_stream agent_identities agent_identity_history agent_inbox
agent_inbox_read_status agent_sessions alert_events alert_sources alert_webhooks
approval_requests artifact_comments
artifact_history artifact_uri_aliases artifacts audit_log authorized_groups
channel_routes connected_accounts contacts conversations group_challenge_codes
heartbeat_notifications heartbeat_state inbox_thread_messages
inbox_thread_participants inbox_thread_read_status inbox_threads integration_health
kindle_lineage kindle_tokens links mcp_tokens memories memory_embedding_chunks
memory_history memory_recall_benchmark_case_results memory_recall_benchmark_metrics
memory_recall_benchmark_runs memory_summary_cache messages mini_app_records notes
project_slug_aliases projects recall_feedback reminder_history reminders
scheduled_reminders session_focus session_logs session_observe_grants
session_transcript_archives sessions skill_installations skill_versions skills
studio_lease_events studios task_comments task_edges task_gate_events
task_graph_revisions task_group_comments task_groups tasks thread_key_types
trusted_users user_identity user_identity_history user_permissions users
workspace_members workspaces
""".split())
# Fixture tables that exist only in a window of the migration sequence: created
# by one migration and, when the second stamp is set, dropped by a later one. A
# rehearsal stack cut between the two (INTEGRATION_MIGRATIONS_UNTIL, spec
# inkmail-thread-scope §4) carries the attestation tables and the rehearsal
# suite writes to them, so for that stack they are fixture tables; for every
# other stack they are absent. A table created by a migration and never dropped
# is the mirror image: present on every stack whose cut is past its creating
# migration, absent on a rehearsal cut before it (the revocation tables, PR
# #678, failed the rehearsal job as "4 missing" while listed unconditionally).
# The catalog check expects exactly that in both directions. Entries are
# (created_by, dropped_by or "", tables).
WINDOWED_FIXTURE_TABLES = (
    ("20260913081634", "20260913090000",
     ("inkmail_cutover_principal_attestations", "inkmail_cutover_thread_attestations")),
    ("20260924070106", "",
     ("browser_companion_grant_events", "browser_companion_grants")),
    ("20260925080025", "",
     ("observation_conflicts", "publication_operation_events", "publication_operations",
      "task_authority_holds")),
)
EXCLUDED_TABLES = ("pcp_config", "permission_definitions")
POLICY = ("fixture-baseline-v5:" + ",".join(FIXTURE_TABLES + EXCLUDED_TABLES) + "|window:" +
          ";".join(created + "-" + dropped + ":" + ",".join(tables)
                   for created, dropped, tables in WINDOWED_FIXTURE_TABLES))


def fixture_tables(until=""):
    """The fixture tables of a stack whose migrations stop before `until`.

    Empty means every migration applied. The stack withholds a migration whose
    stamp is >= until (integration-stack.prepare), so a windowed table exists
    when its creating migration was applied and its dropping one, if any, was
    withheld.
    """
    tables = FIXTURE_TABLES
    for created_by, dropped_by, names in WINDOWED_FIXTURE_TABLES:
        created = not until or created_by < until
        dropped = bool(dropped_by) and (not until or dropped_by < until)
        if created and not dropped:
            tables += names
    return tables
DATABASE_GUARD = """DO $guard$ BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Refusing fixture cleanup: wrong database name' USING ERRCODE = 'PC001';
  END IF;
END $guard$;
"""
# Diagnostics come from fixed SQLSTATEs, never from error text or fixture rows.
# PC avoids P0 codes already used by built-in PL/pgSQL exceptions.
REFUSAL_CODES = {
    "PC001": "wrong database name",
    "PC002": "stack identity mismatch",
    "PC003": "excluded reference table drift",
    "PC004": "restored baseline checksum mismatch",
}


def validate_identity(info, project, recorded_id, db_port):
    """Pure refusal guard; tests must never execute a wrong-target payload."""
    if not re.fullmatch(r"ink-integration(?:-[a-zA-Z0-9_-]+)?", project):
        raise Refusal("Fixture cleanup requires an integration project name.")
    if not isinstance(recorded_id, str) or not re.fullmatch(r"[a-f0-9]{12}(?:[a-f0-9]{52})?", recorded_id):
        raise Refusal("Fixture cleanup has no recorded database container ID; use --reset.")
    if not isinstance(info, dict):
        raise Refusal("Cannot verify fixture database container identity.")
    actual_id = info.get("id")
    if (not isinstance(actual_id, str) or not re.fullmatch(r"[a-f0-9]{64}", actual_id)
            or actual_id[:len(recorded_id)] != recorded_id
            or info.get("name") != "/supabase_db_" + project
            or info.get("project") != project or info.get("running") is not True
            or info.get("paused") is not False):
        raise Refusal("Refusing fixture cleanup: database container name/ID/project/state mismatch.")
    bindings = info.get("ports")
    if (not isinstance(bindings, list) or not bindings or
            any(not isinstance(b, dict) or b.get("HostPort") != str(db_port)
                for b in bindings)):
        raise Refusal("Refusing fixture cleanup: database port mismatch.")
    return actual_id


def checked_container(project, recorded_id, db_port):
    # Ask only for identity fields. Full docker inspect output includes secrets.
    template = ('{"id":{{json .Id}},"name":{{json .Name}},'
                '"project":{{json (index .Config.Labels "com.supabase.cli.project")}},'
                '"running":{{json .State.Running}},"paused":{{json .State.Paused}},'
                '"ports":{{json (index .NetworkSettings.Ports "5432/tcp")}}}')
    if not isinstance(recorded_id, str) or not re.fullmatch(r"[a-f0-9]{12}(?:[a-f0-9]{52})?", recorded_id):
        raise Refusal("No recorded database container ID for fixture cleanup.")
    try:
        result = subprocess.run(["docker", "inspect", "--format", template, recorded_id],
                                capture_output=True, text=True, timeout=15, check=True)
        info = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise Refusal("Cannot inspect the recorded fixture database container; refusing cleanup.") from None
    return validate_identity(info, project, recorded_id, db_port)


def db_command(container_id, tool):
    # Pin the immutable ID, never resolve the name again at the mutation boundary.
    # Explicit socket/user/port/db defeat container-side libpq defaults as well.
    # An empty PGSERVICE is NOT unset: libpq tries to resolve service "".
    return ["docker", "exec", "-i", container_id, "env", "-u", "PGOPTIONS",
            "-u", "PGSERVICE", "-u", "PGSERVICEFILE", tool,
            "--host=/var/run/postgresql", "--port=5432",
            "--username=postgres", "--dbname=" + DATABASE, "--no-password"]


def execute(container_id, tool, args, lock_fds, sql=None, phase="SQL operation"):
    try:
        diagnostics = ["-v", "VERBOSITY=sqlstate"] if tool == "psql" else []
        return subprocess.run(db_command(container_id, tool) + diagnostics + args, input=sql,
                              capture_output=True, text=True, check=True, timeout=60,
                              pass_fds=lock_fds).stdout
    except (OSError, subprocess.SubprocessError) as error:
        # Never echo SQL, dump contents, connection strings or subprocess stderr.
        detail = type(error).__name__
        if isinstance(error, subprocess.CalledProcessError):
            detail += " exit=" + str(error.returncode)
            sqlstate = re.search(r"ERROR:\s+([0-9A-Z]{5})\s*(?:\n|$)", error.stderr or "")
            if sqlstate:
                detail += " SQLSTATE=" + sqlstate[1]
                if sqlstate[1] in REFUSAL_CODES:
                    detail += " " + REFUSAL_CODES[sqlstate[1]]
        raise Refusal("Fixture " + phase + " failed (" + detail + "); operation stopped. State/marker preserved; "
                      "verify ownership, then use --reset if recovery is needed.") from None


def verify_database(container_id, lock_fds):
    name = execute(container_id, "psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                   lock_fds, "SELECT current_database();\n", phase="database-name probe").strip()
    if name != DATABASE:
        raise Refusal("Refusing fixture cleanup: exact database name does not match postgres.")


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def verify_catalog(container_id, lock_fds, tables=FIXTURE_TABLES):
    output = execute(container_id, "psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                     lock_fds, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;\n",
                     phase="catalog probe")
    actual = set(output.splitlines())
    expected = set(tables + EXCLUDED_TABLES)
    if actual != expected:
        # Names are not printed: an unexpected relation can contain private text.
        raise Refusal("Public table classification differs (" + str(len(actual - expected)) +
                      " unclassified, " + str(len(expected - actual)) +
                      " missing). Review the explicit fixture/exclusion lists before reuse.")


def checksum_expression(tables):
    entries = []
    for table in tables:
        entries += [literal(table), "(SELECT md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' "
                    "ORDER BY row_to_json(t)::text), '')) FROM public." + table + " AS t)"]
    # jsonb_build_object accepts at most 100 arguments; keep each table separate.
    return " || ".join("jsonb_build_object(" + ", ".join(entries[i:i+2]) + ")"
                       for i in range(0, len(entries), 2))


def checksum_guard(tables):
    # Distinguish refusal before mutation from a failed restore verification.
    code = "PC003" if tuple(tables) == EXCLUDED_TABLES else "PC004"
    # The full set exceeds jsonb_build_object's argument limit too.
    expected = " || ".join("jsonb_build_object(" + literal(t) +
                           ", (SELECT checksums -> " + literal(t) + " FROM _ink_it.stack))" for t in tables)
    return ("DO $checks$ BEGIN IF (" + checksum_expression(tables) + ") IS DISTINCT FROM (" + expected +
            ") THEN RAISE EXCEPTION 'Fixture baseline checksum mismatch' USING ERRCODE = " +
            literal(code) + "; END IF; END $checks$;\n")


def identity_guard(project, container_id, signature, token, run_id=None):
    # These two fields can come from persisted state. Reject invalid UUIDs before
    # constructing SQL, rather than relying only on SQL literal escaping.
    token = canonical_uuid(token)
    if run_id is not None:
        run_id = canonical_uuid(run_id)
    predicates = ["project = " + literal(project), "db_id = " + literal(container_id),
                  "fingerprint = " + literal(signature), "token = " + literal(token) + "::uuid"]
    if run_id is not None:
        predicates.append("run_id = " + literal(run_id) + "::uuid")
    return DATABASE_GUARD + ("DO $identity$ BEGIN PERFORM 1 FROM _ink_it.stack WHERE singleton AND " +
                            " AND ".join(predicates) + " FOR UPDATE; IF NOT FOUND THEN "
                            "RAISE EXCEPTION 'Fixture stack identity mismatch' USING ERRCODE = 'PC002'; END IF; END $identity$;\n")


def canonical_uuid(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise Refusal("Invalid persisted fixture identity/run token; refusing SQL construction.") from None


def transaction(container_id, sql, lock_fds, phase="transaction"):
    return execute(container_id, "psql", ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", "-"],
                   lock_fds, "SET TIME ZONE 'UTC';\nSET lock_timeout = '5s';\n" + sql, phase=phase)


def capture_baseline(workdir, project, recorded_id, db_port, lock_fds, signature, run_id, until=""):
    """Called ONLY after successful managed reset, before tests can write rows."""
    run_id = canonical_uuid(run_id)
    tables = fixture_tables(until)
    container_id = checked_container(project, recorded_id, db_port)
    verify_database(container_id, lock_fds)
    verify_catalog(container_id, lock_fds, tables)
    checksums = execute(container_id, "psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                        lock_fds, "SET TIME ZONE 'UTC';\nSELECT " + checksum_expression(tables + EXCLUDED_TABLES) + ";\n",
                        phase="cold checksum capture")
    # psql emits SET even in tuples-only mode. The final line is the JSON row.
    try:
        checksums = json.loads(checksums.strip().splitlines()[-1])
        if set(checksums) != set(tables + EXCLUDED_TABLES):
            raise ValueError()
    except (ValueError, IndexError, TypeError):
        raise Refusal("Could not record the cold fixture baseline checksums.") from None
    args = ["--data-only", "--column-inserts", "--no-owner",
            "--no-privileges", "--no-comments", "--strict-names", "--no-blobs"]
    for table in tables:
        args += ["--table=public." + table]
    baseline = execute(container_id, "pg_dump", args, lock_fds, phase="baseline dump")
    if not baseline.strip() or len(baseline.encode()) > 10 * 1024 * 1024:
        raise Refusal("Unexpected fixture baseline size; refusing to mark this stack ready.")
    path = workdir / BASELINE_FILE
    temp = path.with_suffix(".tmp")
    temp.write_text(baseline)
    temp.chmod(0o600)
    temp.replace(path)
    token = str(uuid.uuid4())
    # Test-only metadata, not an application migration. Never exposed to REST;
    # a reset replaces it before another suite can start. An app DB lacks it.
    transaction(container_id, DATABASE_GUARD + """
CREATE SCHEMA IF NOT EXISTS _ink_it;
REVOKE ALL ON SCHEMA _ink_it FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS _ink_it.stack (
  singleton boolean PRIMARY KEY CHECK (singleton), project text NOT NULL,
  db_id text NOT NULL, fingerprint text NOT NULL, token uuid NOT NULL,
  checksums jsonb NOT NULL, run_id uuid, started_at timestamptz
);
DELETE FROM _ink_it.stack;
INSERT INTO _ink_it.stack VALUES (true, """ + ", ".join(map(literal, (
        project, container_id, signature, token, json.dumps(checksums), run_id))) + ", now());\n", lock_fds,
                phase="marker initialization")
    return {"hash": hashlib.sha256(baseline.encode()).hexdigest(), "token": token}


def clean_fixtures(workdir, project, recorded_id, db_port, baseline_state, lock_fds, signature, run_id, until=""):
    path = workdir / BASELINE_FILE
    tables = fixture_tables(until)
    if (path.is_symlink() or not path.is_file() or not isinstance(baseline_state, dict)
            or not baseline_state.get("hash") or not baseline_state.get("token")):
        raise Refusal("Fixture baseline is missing or unmanaged; run --reset once.")
    canonical_uuid(baseline_state["token"])
    run_id = canonical_uuid(run_id)
    baseline = path.read_text()
    if hashlib.sha256(baseline.encode()).hexdigest() != baseline_state["hash"]:
        raise Refusal("Fixture baseline changed outside the harness; refusing cleanup. Use --reset.")
    container_id = checked_container(project, recorded_id, db_port)
    verify_database(container_id, lock_fds)
    verify_catalog(container_id, lock_fds, tables)
    guard = identity_guard(project, container_id, signature, baseline_state["token"])
    # Commit the diagnostic marker BEFORE cleanup; failed cleanup/suite leaves it.
    transaction(container_id, guard + "UPDATE _ink_it.stack SET run_id = " + literal(run_id) +
                "::uuid, started_at = now();\n", lock_fds, phase="run marker acquisition")
    guard = identity_guard(project, container_id, signature, baseline_state["token"], run_id)
    # ONLY excludes descendants; RESTRICT prevents cleanup expanding via FKs.
    # A single transaction rolls back truncation and trigger changes on failure.
    # Supabase grants postgres session_replication_role without superuser access.
    # Suppress normal triggers/FKs only while restoring the trusted cold dump;
    # SET LOCAL reverts on rollback. No admin login or persistent ALTER TRIGGER.
    # Row checksums after restoring origin mode still gate the transaction.
    # pg_dump resets lock_timeout and search_path: keep TRUNCATE before its
    # preamble and everything after it schema-qualified.
    truncate = "TRUNCATE " + ", ".join("ONLY public." + t for t in tables) + " CONTINUE IDENTITY RESTRICT;\n"
    restore = "SET LOCAL session_replication_role = replica;\n" + baseline + "\nSET LOCAL session_replication_role = origin;\n"
    transaction(container_id, guard + checksum_guard(EXCLUDED_TABLES) + truncate + restore +
                checksum_guard(tables + EXCLUDED_TABLES), lock_fds, phase="scoped cleanup")


def finish_run(project, recorded_id, db_port, baseline_state, lock_fds, signature, run_id):
    container_id = checked_container(project, recorded_id, db_port)
    transaction(container_id, identity_guard(project, container_id, signature, baseline_state["token"], run_id) +
                "UPDATE _ink_it.stack SET run_id = NULL, started_at = NULL;\n", lock_fds, phase="run marker completion")
