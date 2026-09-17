#!/usr/bin/env python3
"""Pure guards + mocked executors only. Never connects to Docker or PostgreSQL."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent / "lib"))
module_path = Path(os.environ.get("INTEGRATION_DATA_UNDER_TEST", str(Path(__file__).parent / "lib/integration_data.py")))
spec = importlib.util.spec_from_file_location("integration_data_under_test", module_path)
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)


class DataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workdir = Path(self.temp.name)
        self.project = "pcp-integration"
        self.id = "a" * 64
        self.info = {"id": self.id, "name": "/supabase_db_pcp-integration",
                     "project": self.project, "running": True, "paused": False,
                     "ports": [{"HostIp": "127.0.0.1", "HostPort": "55422"}]}
        self.baseline = "-- Synthetic fixture baseline; no real records.\nSELECT 1;\n"
        self.digest = hashlib.sha256(self.baseline.encode()).hexdigest()
        (self.workdir / data.BASELINE_FILE).write_text(self.baseline)
        self.state = {"hash": self.digest, "token": "11111111-1111-4111-8111-111111111111"}
        self.signature = "fixture-signature"
        self.run_id = "22222222-2222-4222-8222-222222222222"
        self.calls = []
        self.database = "postgres"
        self.failed_tool = None
        self.catalog = data.FIXTURE_TABLES + data.EXCLUDED_TABLES
        patch = mock.patch.object(data.subprocess, "run", self.run_command)
        patch.start()
        self.addCleanup(patch.stop)

    def run_command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        self.assertNotIn("shell", kwargs)
        if args[:2] == ["docker", "inspect"]:
            output = json.dumps(self.info)
        else:
            self.assertEqual(args[:3], ["docker", "exec", "-i"])
            self.assertIn(self.id, args)
            self.assertIn("--host=/var/run/postgresql", args)
            self.assertIn("--dbname=postgres", args)
            self.assertEqual(kwargs["pass_fds"], [7])
            if self.failed_tool in args:
                raise subprocess.CalledProcessError(1, args, stderr="synthetic-private-error")
            if "pg_dump" in args:
                output = self.baseline
            elif "SELECT tablename FROM pg_tables" in (kwargs.get("input") or ""):
                output = "\n".join(self.catalog)
            elif "SELECT jsonb_build_object" in (kwargs.get("input") or ""):
                output = json.dumps({t: "fixture-checksum" for t in data.FIXTURE_TABLES + data.EXCLUDED_TABLES})
            elif kwargs.get("input") == "SELECT current_database();\n":
                output = self.database + "\n"
            else:
                output = ""
        return subprocess.CompletedProcess(args, 0, stdout=output, stderr="")

    def clean(self):
        data.clean_fixtures(self.workdir, self.project, self.id[:12], 55422, self.state, [7], self.signature, self.run_id)

    def mutations(self):
        return [kwargs["input"] for _, kwargs in self.calls if "TRUNCATE " in (kwargs.get("input") or "")]

    def test_correct_identity_accepts_exact_short_or_full_recorded_id(self):
        for recorded in (self.id, self.id[:12]):
            self.assertEqual(data.validate_identity(self.info, self.project, recorded, 55422), self.id)

    def test_wrong_container_identity_refuses_in_isolation(self):
        for field, value in (("id", "b" * 64), ("name", "/supabase_db_application"),
                             ("name", "/supabase_db_pcp-integration-copy"),
                             ("project", "application"), ("running", False),
                             ("paused", True),
                             ("ports", [{"HostPort": "54322"}]), ("ports", []),
                             ("ports", [{"HostPort": "55422"}, {"HostPort": "54322"}])):
            with self.subTest(field=field, value=value):
                bad = dict(self.info, **{field: value})
                with self.assertRaises(data.Refusal):
                    data.validate_identity(bad, self.project, self.id, 55422)
        self.assertEqual(self.calls, [], "pure guard tests must not invoke even the mock executor")

    def test_missing_identity_fields_refuse_in_isolation(self):
        for field in self.info:
            bad = dict(self.info)
            del bad[field]
            with self.subTest(field=field), self.assertRaises(data.Refusal):
                data.validate_identity(bad, self.project, self.id, 55422)

    def test_project_namespace_and_recorded_id_are_not_prefix_matches(self):
        for project, recorded in (("application", self.id), ("pcp-integrationX", self.id),
                                  (self.project, ""), (self.project, None), (self.project, self.id[:11]),
                                  (self.project, "--all")):
            with self.subTest(project=project, recorded=recorded), self.assertRaises(data.Refusal):
                data.validate_identity(self.info, project, recorded, 55422)

    def test_wrong_named_database_refuses_before_any_mutation(self):
        for name in ("production", "postgres_copy", "postgres\nproduction", ""):
            self.database = name
            with self.subTest(name=name), self.assertRaisesRegex(data.Refusal, "exact database name"):
                self.clean()
        self.assertEqual(self.mutations(), [])

    def test_live_container_metadata_is_checked_before_sql(self):
        self.info["name"] = "/supabase_db_application"
        with self.assertRaises(data.Refusal):
            self.clean()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0][:2], ["docker", "inspect"])

    def test_guard_is_repeated_in_same_transaction_before_scoped_truncate(self):
        self.clean()
        self.assertEqual(len(self.mutations()), 1)
        sql = self.mutations()[0]
        self.assertLess(sql.index("current_database() <> 'postgres'"), sql.index("TRUNCATE "))
        self.assertIn("RAISE EXCEPTION", sql)
        self.assertIn("CONTINUE IDENTITY RESTRICT;", sql)
        self.assertNotIn("CASCADE", sql)
        self.assertNotIn("DROP ", sql)
        self.assertIn(self.baseline, sql)
        self.assertLess(sql.index(self.baseline), sql.rindex("Fixture baseline checksum mismatch"))
        command, opts = self.calls[-1]
        self.assertIn("--single-transaction", command)
        self.assertIn("ON_ERROR_STOP=1", command)
        self.assertIn("-X", command)
        self.assertTrue(opts["check"])
        self.assertEqual(opts["timeout"], 60)

    def test_scope_is_explicit_and_never_whole_schema_or_database(self):
        self.clean()
        sql = self.mutations()[0]
        truncate = sql[sql.index("TRUNCATE "):sql.index(" CONTINUE IDENTITY")]
        names = tuple(part.removeprefix("ONLY public.") for part in truncate[9:].split(", "))
        self.assertEqual(names, data.FIXTURE_TABLES)
        self.assertEqual(len(set(names)), len(names))
        self.assertEqual(len(names), 70)
        for excluded in ("pcp_config", "permission_definitions", "auth.users", "storage.objects",
                         "supabase_migrations.schema_migrations"):
            self.assertNotIn(excluded, names)
        self.assertNotIn("pg_tables", sql)
        self.assertNotIn("pg_class", sql)

    def test_baseline_is_captured_with_selected_tables_only(self):
        result = data.capture_baseline(self.workdir, self.project, self.id, 55422, [7], self.signature, self.run_id)
        self.assertEqual(result["hash"], self.digest)
        self.assertTrue(result["token"])
        command, _ = next(call for call in self.calls if "pg_dump" in call[0])
        self.assertIn("pg_dump", command)
        for flag in ("--data-only", "--disable-triggers", "--strict-names", "--no-large-objects"):
            self.assertIn(flag, command)
        self.assertEqual([s[8:] for s in command if s.startswith("--table=")],
                         ["public." + t for t in data.FIXTURE_TABLES])
        self.assertNotIn("--clean", command)
        self.assertNotIn("--create", command)
        self.assertEqual((self.workdir / data.BASELINE_FILE).stat().st_mode & 0o777, 0o600)

    def test_baseline_capture_checks_exact_database_name(self):
        self.database = "wrong"
        with self.assertRaises(data.Refusal):
            data.capture_baseline(self.workdir, self.project, self.id, 55422, [7], self.signature, self.run_id)
        self.assertFalse(any("pg_dump" in args for args, _ in self.calls))

    def test_missing_changed_or_symlinked_baseline_refuses_before_sql(self):
        path = self.workdir / data.BASELINE_FILE
        for kind in ("missing", "changed", "symlink"):
            path.unlink(missing_ok=True)
            if kind == "changed":
                path.write_text("-- tampered fixture\n")
            elif kind == "symlink":
                other = self.workdir / "other.sql"
                other.write_text(self.baseline)
                path.symlink_to(other)
            with self.subTest(kind=kind), self.assertRaises(data.Refusal):
                self.clean()
        self.assertEqual(self.calls, [])

    def test_dump_failure_never_replaces_baseline(self):
        self.failed_tool = "pg_dump"
        with self.assertRaises(data.Refusal):
            data.capture_baseline(self.workdir, self.project, self.id, 55422, [7], self.signature, self.run_id)
        self.assertEqual((self.workdir / data.BASELINE_FILE).read_text(), self.baseline)

    def test_restore_failure_is_not_swallowed_or_leaked(self):
        original = self.run_command
        def fail_restore(args, **kwargs):
            if "TRUNCATE " in (kwargs.get("input") or ""):
                raise subprocess.CalledProcessError(1, args, stderr="synthetic-private-error")
            return original(args, **kwargs)
        with mock.patch.object(data.subprocess, "run", fail_restore), self.assertRaises(data.Refusal) as error:
            self.clean()
        self.assertNotIn("synthetic-private-error", str(error.exception))
        self.assertIn("suite not started", str(error.exception))

    def test_inspection_parse_or_command_failure_refuses(self):
        for result in (subprocess.CompletedProcess([], 0, stdout="not json"),
                       subprocess.TimeoutExpired([], 15)):
            with self.subTest(result=type(result).__name__), \
                 mock.patch.object(data.subprocess, "run", side_effect=result if isinstance(result, Exception) else None,
                                   return_value=result), self.assertRaises(data.Refusal):
                self.clean()

    def test_unclassified_or_missing_table_refuses_before_mutation(self):
        for tables in (self.catalog + ("unclassified_fixture",), self.catalog[1:]):
            self.catalog = tables
            with self.subTest(tables=len(tables)), self.assertRaisesRegex(data.Refusal, "classification differs"):
                self.clean()
        self.assertEqual(self.mutations(), [])

    def test_same_connection_identity_guard_precedes_marker_and_mutation(self):
        self.clean()
        updates = [opts["input"] for _, opts in self.calls if "UPDATE _pcp_it.stack" in (opts.get("input") or "")]
        self.assertEqual(len(updates), 1)
        update = updates[0]
        for sql in (update, self.mutations()[0]):
            for value in (self.project, self.id, self.signature, self.state["token"]):
                self.assertIn(data.literal(value), sql)
            self.assertIn("FOR UPDATE", sql)
            self.assertIn("IF NOT FOUND", sql)
            self.assertIn("RAISE EXCEPTION 'Fixture stack identity mismatch'", sql)
        self.assertLess(update.index("Fixture stack identity mismatch"), update.index("UPDATE _pcp_it.stack"))
        self.assertIn("run_id = " + data.literal(self.run_id), self.mutations()[0])

    def test_excluded_and_full_checksums_bracket_the_mutation(self):
        self.clean()
        sql = self.mutations()[0]
        before, after = sql.split("TRUNCATE ", 1)
        self.assertIn(data.checksum_guard(data.EXCLUDED_TABLES), before)
        self.assertTrue(after.endswith(data.checksum_guard(data.FIXTURE_TABLES + data.EXCLUDED_TABLES)))

    def test_cold_capture_initializes_database_marker_before_returning(self):
        result = data.capture_baseline(self.workdir, self.project, self.id, 55422, [7], self.signature, self.run_id)
        sql = self.calls[-1][1]["input"]
        self.assertIn("CREATE SCHEMA IF NOT EXISTS _pcp_it", sql)
        self.assertIn("REVOKE ALL ON SCHEMA", sql)
        for value in (result["token"], self.signature, self.id, self.project, self.run_id):
            self.assertIn(data.literal(value), sql)
        self.assertNotIn("TRUNCATE ", sql)
        self.assertFalse(self.mutations())

    def test_finish_only_clears_marker_for_its_own_identity_and_run(self):
        data.finish_run(self.project, self.id, 55422, self.state, [7], self.signature, self.run_id)
        sql = self.calls[-1][1]["input"]
        self.assertIn("run_id = " + data.literal(self.run_id), sql)
        self.assertIn("Fixture stack identity mismatch", sql)
        self.assertIn("UPDATE _pcp_it.stack SET run_id = NULL", sql)
        self.assertFalse(self.mutations())


if __name__ == "__main__":
    unittest.main()
