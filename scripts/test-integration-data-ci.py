#!/usr/bin/env python3
"""Destructive fixture probes: disposable GitHub-hosted runner/container ONLY.

Local guard tests live in test-integration-data.py and never use real executors.
This script is never invoked by the local test entry point.
"""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).parent / "lib"))
import integration_data as data


def refused(fn, expected):
    try:
        fn()
    except data.Refusal as error:
        # A permission or syntax failure is NOT evidence the intended guard ran.
        assert expected in str(error), "Refused for an unexpected reason: " + str(error)
        return
    raise AssertionError("Expected refusal; unsafe probe proceeded")


def main():
    if not all(os.environ.get(k) == v for k, v in {
        "CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
        "INK_DISPOSABLE_RUNNER_TESTS": "1",
    }.items()):
        if os.environ.get("INK_DISPOSABLE_RUNNER_TESTS") == "1":
            raise SystemExit("Refusing opted-in destructive probes outside a disposable CI runner.")
        print("SKIP: destructive integration-data probes require an opted-in disposable CI runner.")
        return
    spec = importlib.util.spec_from_file_location("stack", Path(__file__).parent / "lib/integration-stack.py")
    stack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stack)
    project, ports, _ = stack.settings(os.environ)
    workdir = Path.home() / ".cache/inkwell/integration-db" / project
    state = json.loads((workdir / "state.json").read_text())
    assert state["project"] == project
    run_id = str(uuid.uuid4())
    with stack.locks(Path.home() / ".cache/inkwell/integration-db-locks", project, ports) as fds:
        container_id = data.checked_container(project, state["dbId"], ports[1])
        guard = data.identity_guard(project, container_id, state["fingerprint"], state["baseline"]["token"])

        def sql(text):
            return data.execute(container_id, "psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], fds, text)

        def clean(baseline=None):
            data.clean_fixtures(workdir, project, state["dbId"], ports[1], baseline or state["baseline"],
                                fds, state["fingerprint"], run_id)

        residue_id = "00000000-0000-4000-8000-000000000649"
        # This dedicated test schema is outside the public cleanup allowlist.
        data.transaction(container_id, guard + """
CREATE TABLE _pcp_it.cleanup_probe (value text PRIMARY KEY);
INSERT INTO _pcp_it.cleanup_probe VALUES ('must-survive');
INSERT INTO public.notes (id, user_id, title, content)
VALUES ('00000000-0000-4000-8000-000000000649', '550e8400-e29b-41d4-a716-446655440000',
        'Synthetic interrupted fixture', 'must-be-cleaned');
UPDATE _pcp_it.stack SET run_id = '00000000-0000-4000-8000-000000000648';
""", fds)

        def residue_count():
            return sql("SELECT count(*) FROM public.notes WHERE id = '" + residue_id + "';").strip()

        # A name typo on the same disposable Postgres must fail its own guard,
        # not accidentally fail because a target table is absent in template1.
        command = [arg.replace("--dbname=postgres", "--dbname=template1") for arg in
                   data.db_command(container_id, "psql")]
        result = subprocess.run(command + ["-X", "-v", "ON_ERROR_STOP=1", "-f", "-"],
                                input=data.DATABASE_GUARD + "SELECT 1;", capture_output=True, text=True,
                                timeout=15, pass_fds=fds)
        assert result.returncode != 0 and "wrong database name" in result.stderr

        # Same connection identity guard refuses a validly-shaped wrong token.
        wrong = dict(state["baseline"], token="00000000-0000-4000-8000-000000000000")
        refused(lambda: clean(wrong), "SQLSTATE=PC002")
        assert residue_count() == "1"

        data.transaction(container_id, guard + "ALTER TABLE _pcp_it.stack RENAME TO missing_marker_probe;", fds)
        refused(clean, "SQLSTATE=42P01")
        assert residue_count() == "1"
        # The assertion is missing by design; restoration targets this pinned CI
        # container only. No fallback to a host URL or a production database.
        data.transaction(container_id, data.DATABASE_GUARD + "ALTER TABLE _pcp_it.missing_marker_probe RENAME TO stack;", fds)

        # Classification must fail for an independent table with NO foreign keys.
        data.transaction(container_id, guard + "CREATE TABLE public.cleanup_unclassified_probe (value text);", fds)
        refused(clean, "Public table classification differs")
        assert residue_count() == "1"
        data.transaction(container_id, guard + "DROP TABLE public.cleanup_unclassified_probe;", fds)

        # A changed excluded table is refused, not silently carried into the suite.
        data.transaction(container_id, guard + "INSERT INTO public.pcp_config (key, value) VALUES ('cleanup-ci-probe', 'fixture');", fds)
        refused(clean, "SQLSTATE=PC003")
        assert residue_count() == "1"
        data.transaction(container_id, guard + "DELETE FROM public.pcp_config WHERE key = 'cleanup-ci-probe';", fds)

        # Force a restore error AFTER truncation; transaction must preserve residue.
        path = workdir / data.BASELINE_FILE
        original = path.read_text()
        broken = original + "\nSELECT 1/0;\n"
        try:
            path.write_text(broken)
            fault = dict(state["baseline"], hash=data.hashlib.sha256(broken.encode()).hexdigest())
            refused(lambda: clean(fault), "SQLSTATE=22012")
            assert residue_count() == "1", "failed restore committed truncation"
        finally:
            path.write_text(original)

        clean()
        assert residue_count() == "0"
        assert sql("SELECT value FROM _pcp_it.cleanup_probe;").strip() == "must-survive"
        # One comparison across ALL classified public tables, including exclusions,
        # against hashes captured on the cold reset before the first test wrote.
        data.transaction(container_id, guard + data.checksum_guard(data.FIXTURE_TABLES + data.EXCLUDED_TABLES), fds)
        assert sql("SELECT run_id FROM _pcp_it.stack;").strip() == run_id
        data.finish_run(project, state["dbId"], ports[1], state["baseline"], fds, state["fingerprint"], run_id)
        assert sql("SELECT run_id IS NULL FROM _pcp_it.stack;").strip() == "t"
        print("PASS: cold-baseline row checksums match all 72 public tables after warm cleanup;")
        print("wrong DB/token, unknown table, excluded drift and rollback controls passed; outside sentinel survived.")


if __name__ == "__main__":
    main()
