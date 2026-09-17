#!/usr/bin/env python3
"""Lifecycle tests. Docker, Supabase, Yarn, and suite execution are all mocked."""

import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE_PATH = Path(os.environ.get("INTEGRATION_STACK_UNDER_TEST", str(Path(__file__).parent / "lib/integration-stack.py"))).resolve()
sys.path.insert(0, str(Path(__file__).parent / "lib"))
spec = importlib.util.spec_from_file_location("stack", MODULE_PATH)
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


TEST_CONFIG = "[api]\nport = 54321\n[db]\nport = 54322\n[studio]\nport = 54323\n[inbucket]\nport = 54324\nsmtp_port = 54325\npop3_port = 54326\n"


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "supabase/migrations").mkdir(parents=True)
        (self.root / "supabase/config.toml").write_text(TEST_CONFIG)
        (self.root / "supabase/migrations/20260101000000_fixture.sql").write_text("select 1;")
        self.harness = self.root / "scripts/test-integration-db-local.sh"
        self.env = {"INTEGRATION_SUPABASE_CACHE_DIR": str(self.root / "cache"),
                    "INTEGRATION_SUPABASE_WORKDIR_BASE": str(self.root)}
        self.project = "pcp-integration"
        self.db = "supabase_db_" + self.project
        self.current = {}
        self.calls = []
        self.fail_command = None
        self.suite_code = 0
        for target, replacement in (
            ("capture", self.capture), ("containers", lambda _: dict(self.current)),
            ("port_preflight", lambda _: self.calls.append(["preflight"])),
            ("say", lambda _: None),
            ("capture_baseline", lambda *args: self.calls.append(["capture-baseline"]) or "fixture-baseline-hash"),
            ("clean_fixtures", lambda *args: self.calls.append(["clean-fixtures"])),
            ("finish_run", lambda *args: None),
        ):
            patch = mock.patch.object(stack, target, replacement, create=True)
            patch.start()
            self.addCleanup(patch.stop)
        for target, replacement in (
            ("check_call", self.command), ("run", self.run_command), ("call", self.suite),
        ):
            patch = mock.patch.object(stack.subprocess, target, replacement)
            patch.start()
            self.addCleanup(patch.stop)
        for patch in (mock.patch.object(stack.Path, "home", return_value=self.root),
                      mock.patch.object(stack.shutil, "which", return_value="/mock/command")):
            patch.start()
            self.addCleanup(patch.stop)

    def capture(self, args):
        self.assertEqual(args, ["supabase", "--version"])
        return "2.84.2"

    def command(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ["docker", "info"]:
            return 0
        self.assertEqual(args[0], "supabase")
        if args[1] == self.fail_command:
            raise subprocess.CalledProcessError(1, args)
        if args[1] == "start":
            self.current = {self.db: "fixture-db-id", "supabase_rest_" + self.project: "fixture-rest-id"}
        elif args[1] == "stop":
            self.current = {}
        else:
            self.assertEqual(args[1:3], ["db", "reset"])
        return 0

    def suite(self, args, **kwargs):
        self.calls.append(args)
        self.suite_env = kwargs["env"]
        self.assertTrue(kwargs["pass_fds"], "suite must retain ownership locks if parent exits")
        return self.suite_code

    def run_command(self, args, **kwargs):
        # run() returns a status by default; unlike check_call(), it does not
        # raise. A failed stop must not be made safe by the test double itself.
        try:
            code = self.command(args, **kwargs)
        except subprocess.CalledProcessError as error:
            if kwargs.get("check"):
                raise
            code = error.returncode
        return subprocess.CompletedProcess(args, code, stdout="", stderr="")

    def run_stack(self, *args):
        return stack.manage(self.root, self.harness, args, self.env)

    def count(self, *prefix):
        return sum(command[:len(prefix)] == list(prefix) for command in self.calls)

    def state(self):
        return json.loads((self.root / "cache" / self.project / "state.json").read_text())

    def test_two_local_runs_start_and_reset_only_once(self):
        self.assertEqual(self.run_stack(), 0)
        self.assertEqual(self.run_stack("src/auth/fixture.integration.test.ts"), 0)
        self.assertEqual(self.count("supabase", "start"), 1)
        self.assertEqual(self.count("supabase", "db", "reset"), 1)
        self.assertEqual(self.count("supabase", "stop"), 0)
        self.assertEqual(self.count("bash"), 2)
        self.assertEqual(self.calls[-1][-1], "src/auth/fixture.integration.test.ts")
        self.assertEqual(self.suite_env["INTEGRATION_MANAGED_API_PORT"], "55421")
        self.assertEqual(self.suite_env["INTEGRATION_MANAGED_DB_PORT"], "55422")
        self.assertTrue(self.state()["fingerprint"])
        self.assertEqual(self.count("capture-baseline"), 1)
        self.assertEqual(self.count("clean-fixtures"), 1)

    def test_cold_and_reset_capture_baseline_before_tests_without_truncating(self):
        self.run_stack()
        self.run_stack("--reset")
        self.assertEqual(self.count("capture-baseline"), 2)
        self.assertEqual(self.count("clean-fixtures"), 0)
        self.assertIn("baseline", self.state())
        self.assertEqual(self.state()["baseline"], "fixture-baseline-hash")
        for index, command in enumerate(self.calls):
            if command[0] == "capture-baseline":
                self.assertEqual(self.calls[index - 1][:3], ["supabase", "db", "reset"])
                self.assertEqual(self.calls[index + 1][0], "bash")

    def test_marker_exists_during_suite_and_is_removed_only_on_success(self):
        original = self.suite
        def inspect(args, **kwargs):
            path = Path(kwargs["env"]["INTEGRATION_MANAGED_WORKDIR"]) / "run.json"
            self.assertTrue(path.exists(), "run marker must exist before the suite")
            marker = json.loads(path.read_text())
            self.assertEqual(marker["phase"], "testing")
            self.assertEqual(marker["project"], self.project)
            self.assertEqual(marker["pid"], os.getpid())
            self.assertTrue(marker["runId"])
            return original(args, **kwargs)
        with mock.patch.object(stack.subprocess, "call", inspect):
            self.run_stack()
        self.assertFalse((Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "run.json").exists())

    def test_failed_suite_marker_survives_and_retry_cleans_without_reset(self):
        self.suite_code = 7
        self.assertEqual(self.run_stack(), 7)
        marker = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "run.json"
        self.assertTrue(marker.exists())
        self.suite_code = 0
        with mock.patch.object(stack, "say") as output:
            self.assertEqual(self.run_stack(), 0)
        self.assertTrue(any("Previous run did not complete" in call.args[0] for call in output.call_args_list))
        self.assertEqual(self.count("clean-fixtures"), 1)
        self.assertEqual(self.count("supabase", "db", "reset"), 1)
        self.assertFalse(marker.exists())

    def test_retained_interrupt_preserves_marker_without_being_a_lock(self):
        self.run_stack()
        with mock.patch.object(stack.subprocess, "call", side_effect=SystemExit(143)):
            with self.assertRaises(SystemExit):
                self.run_stack()
        marker = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "run.json"
        self.assertTrue(marker.exists())
        self.assertEqual(self.run_stack(), 0)
        self.assertFalse(marker.exists())
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_failed_cleanup_leaves_marker_and_does_not_start_suite(self):
        self.run_stack()
        def refuse(*args):
            self.assertEqual(json.loads((args[0] / "run.json").read_text())["phase"], "cleaning")
            raise stack.Refusal("fixture cleanup failed")
        with mock.patch.object(stack, "clean_fixtures", refuse), self.assertRaises(stack.Refusal):
            self.run_stack()
        self.assertEqual(self.count("bash"), 1)
        marker = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "run.json"
        self.assertTrue(marker.exists())
        self.run_stack()
        self.assertFalse(marker.exists())
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_failed_baseline_capture_leaves_unready_schema_and_no_suite(self):
        with mock.patch.object(stack, "capture_baseline", side_effect=stack.Refusal("dump failed")):
            with self.assertRaises(stack.Refusal):
                self.run_stack()
        self.assertIsNone(self.state()["fingerprint"])
        self.assertEqual(self.count("bash"), 0)
        self.assertTrue((self.root / "cache" / self.project / "run.json").exists())

    def test_stop_removes_owned_baseline_and_diagnostic_marker(self):
        self.suite_code = 7
        self.run_stack()
        cache = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"])
        (cache / "fixture-baseline.sql").write_text("synthetic baseline")
        self.run_stack("--stop")
        self.assertFalse((cache / "fixture-baseline.sql").exists())
        self.assertFalse((cache / "run.json").exists())
        self.assertEqual(self.run_stack(), 7, "stop must not leave unmanaged-cache debris")

    def test_warm_cleanup_receives_owned_identity_and_baseline_hash(self):
        self.run_stack()
        with mock.patch.object(stack, "clean_fixtures") as clean:
            self.run_stack()
        clean.assert_called_once()
        args = clean.call_args.args
        self.assertEqual(args[:5], (Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]),
                                    self.project, "fixture-db-id", 55422, "fixture-baseline-hash"))
        self.assertTrue(args[5], "cleanup children must hold locks")

    def test_ci_keeps_disposable_lifecycle(self):
        self.env["CI"] = "true"
        self.run_stack()
        self.run_stack()
        self.assertEqual(self.count("supabase", "start"), 2)
        self.assertEqual(self.count("supabase", "db", "reset"), 2)
        self.assertEqual(self.count("supabase", "stop"), 2)
        self.assertFalse(Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]).exists())

    def test_explicit_fresh_and_reuse(self):
        self.run_stack("--fresh")
        self.assertFalse(self.current)
        self.env["CI"] = "true"
        self.run_stack("--reuse")
        self.assertTrue(self.current)

    def test_foreign_project_is_never_reset_or_stopped(self):
        self.current = {self.db: "somebody-elses-container"}
        with self.assertRaisesRegex(stack.Refusal, "already exists"):
            self.run_stack()
        with self.assertRaises(stack.Refusal):
            self.run_stack("--stop")
        self.assertEqual(self.count("supabase"), 0)
        self.assertEqual(self.count("bash"), 0)

    def test_same_project_new_container_identity_is_not_adopted(self):
        self.run_stack()
        self.current[self.db] = "replacement-container"
        with self.assertRaises(stack.Refusal):
            self.run_stack("--reset")
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_port_preflight_refuses_without_cleanup(self):
        with mock.patch.object(stack, "port_preflight", side_effect=stack.Refusal("busy port")):
            with self.assertRaisesRegex(stack.Refusal, "busy port"):
                self.run_stack()
        self.assertEqual(self.count("supabase"), 0)

    def test_schema_drift_requires_explicit_reset(self):
        self.run_stack()
        (self.root / "supabase/seed.sql").write_text("select 2;")
        with self.assertRaisesRegex(stack.Refusal, "--reset"):
            self.run_stack()
        self.run_stack("--reset")
        self.run_stack()
        self.assertEqual(self.count("supabase", "start"), 1)
        self.assertEqual(self.count("supabase", "db", "reset"), 2)

    def test_changed_ports_cannot_silently_reuse_old_stack(self):
        self.run_stack()
        self.env["INTEGRATION_SUPABASE_API_PORT"] = "56421"
        with self.assertRaisesRegex(stack.Refusal, "--stop"):
            self.run_stack("--reset")
        self.assertEqual(self.count("bash"), 1)

    def test_fresh_refuses_owned_running_stack_without_stopping_it(self):
        self.run_stack()
        with self.assertRaisesRegex(stack.Refusal, "--reuse"):
            self.run_stack("--fresh")
        self.assertEqual(self.count("supabase", "stop"), 0)

    def test_stop_removes_state_only_after_stopping_owned_project(self):
        self.run_stack()
        self.run_stack("--stop")
        self.run_stack("--stop")
        self.assertEqual(self.count("supabase", "stop"), 1)
        self.assertFalse(self.current)
        self.assertFalse((self.root / "cache" / self.project / "state.json").exists())

    def test_failed_reset_never_marks_schema_ready(self):
        self.run_stack()
        self.fail_command = "db"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack("--reset")
        self.assertIsNone(self.state()["fingerprint"])
        with self.assertRaisesRegex(stack.Refusal, "--reset"):
            self.run_stack()
        self.assertEqual(self.count("bash"), 1)

    def test_failed_reset_recreated_database_remains_owned_but_not_ready(self):
        self.run_stack()
        original_command = self.command

        def fail_reset(args, **kwargs):
            if args[1:3] == ["db", "reset"]:
                self.current = {self.db: "recreated-before-reset-failed"}
                raise subprocess.CalledProcessError(1, args)
            return original_command(args, **kwargs)

        with mock.patch.object(stack.subprocess, "check_call", fail_reset):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_stack("--reset")
        self.assertEqual(self.state()["dbId"], "recreated-before-reset-failed")
        self.assertIsNone(self.state()["fingerprint"])
        self.run_stack("--stop")
        self.assertFalse(self.current)

    def test_failed_reset_without_database_can_stop_its_remaining_containers(self):
        self.run_stack()
        original_command = self.command

        def fail_reset(args, **kwargs):
            if args[1:3] == ["db", "reset"]:
                self.current = {"supabase_rest_" + self.project: "remaining-rest-container"}
                raise subprocess.CalledProcessError(1, args)
            return original_command(args, **kwargs)

        with mock.patch.object(stack.subprocess, "check_call", fail_reset):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_stack("--reset")
        self.run_stack("--stop")
        self.assertFalse(self.current)

    def test_failed_start_cleans_up_own_attempt(self):
        self.fail_command = "start"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack()
        self.assertEqual(self.count("supabase", "stop"), 1)
        self.assertEqual(self.count("bash"), 0)

    def test_external_database_loss_can_stop_verified_survivors_after_cold_and_warm_runs(self):
        for warm in (False, True):
            with self.subTest(warm=warm):
                self.run_stack()
                if warm:
                    self.run_stack()
                original = dict(self.current)
                try:
                    del self.current[self.db]
                    self.run_stack("--stop")
                    self.assertFalse(self.current)
                finally:
                    # Keep the two probes independent even against the old
                    # implementation whose stop refuses the missing DB.
                    if self.current:
                        self.current = original
                        self.run_stack("--stop")

    def test_external_database_loss_advice_leads_to_working_stop_and_recreate(self):
        self.run_stack()
        self.run_stack()
        del self.current[self.db]
        for args in ((), ("--reuse",), ("--reset",), ("--fresh",)):
            with self.subTest(args=args), self.assertRaisesRegex(stack.Refusal, "DB container is missing.*--stop"):
                self.run_stack(*args)
        self.run_stack("--stop")
        self.run_stack()
        self.assertEqual(self.count("supabase", "start"), 2)
        self.assertEqual(self.count("supabase", "db", "reset"), 2)

    def test_missing_database_cannot_adopt_unknown_or_replaced_survivors(self):
        self.run_stack()
        del self.current[self.db]
        original = dict(self.current)
        for change in ({"supabase_rest_" + self.project: "replacement-id"},
                       {"supabase_unknown_" + self.project: "new-id"}):
            self.current = dict(original, **change)
            for args in (("--stop",), ("--reset",)):
                with self.subTest(change=change, args=args), self.assertRaises(stack.Refusal):
                    self.run_stack(*args)
        self.assertEqual(self.count("supabase", "stop"), 0)
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_port_source_drift_missing_duplicate_and_wrong_section_refuse_before_start(self):
        variants = [TEST_CONFIG.replace(str(port), str(port + 10)) for port in range(54321, 54327)]
        variants += [TEST_CONFIG.replace("port = 54321\n", ""),
                     TEST_CONFIG.replace("port = 54321\n", "port = 54321\nport = 54321\n"),
                     TEST_CONFIG.replace("[api]", "[unrelated]")]
        for config in variants:
            self.calls.clear()
            with self.subTest(config=config):
                (self.root / "supabase/config.toml").write_text(config)
                with self.assertRaisesRegex(stack.Refusal, "port"):
                    self.run_stack("--fresh")
                self.assertEqual(self.count("supabase", "start"), 0)
                self.assertEqual(self.count("bash"), 0)

    def test_port_overrides_cannot_cascade_into_other_default_values(self):
        ports = list(reversed(range(54321, 54327)))
        self.env.update({"INTEGRATION_SUPABASE_" + name + "_PORT": str(port)
                         for name, port in zip(stack.PORT_NAMES, ports)})
        self.run_stack()
        expected = TEST_CONFIG
        # Use unique placeholders to build the independent expected result.
        for index, port in enumerate(range(54321, 54327)):
            expected = expected.replace(str(port), "PORT_" + str(index))
        for index, port in enumerate(ports):
            expected = expected.replace("PORT_" + str(index), str(port))
        self.assertEqual(self.state()["config"], 'project_id = "pcp-integration"\n' + expected)

    def test_missing_port_diagnostic_names_each_missing_section_and_key(self):
        config = TEST_CONFIG.replace("port = 54321\n", "").replace("smtp_port = 54325\n", "")
        (self.root / "supabase/config.toml").write_text(config)
        with self.assertRaises(stack.Refusal) as error:
            self.run_stack()
        self.assertIn("[api].port", str(error.exception))
        self.assertIn("[inbucket].smtp_port", str(error.exception))
        self.assertEqual(self.count("supabase", "start"), 0)

    def test_real_checkout_port_config_and_inline_comments_are_supported(self):
        repo = Path(__file__).resolve().parent.parent
        config = stack.configuration(repo, self.project, list(range(55421, 55427)))
        for port in range(55421, 55427):
            self.assertIn("= " + str(port), config)
        (self.root / "supabase/config.toml").write_text(TEST_CONFIG.replace("54321", "54321  # fixture comment"))
        self.run_stack()
        self.assertIn("port = 55421  # fixture comment", self.state()["config"])

    def test_suite_failure_preserves_return_code_and_reusable_schema(self):
        self.suite_code = 7
        self.assertEqual(self.run_stack(), 7)
        self.assertTrue(self.state()["fingerprint"])
        self.assertEqual(self.count("supabase", "stop"), 0)

    def test_malformed_state_fails_closed(self):
        directory = self.root / "cache" / self.project
        directory.mkdir(parents=True)
        (directory / "state.json").write_text("not json")
        with self.assertRaisesRegex(stack.Refusal, "unreadable"):
            self.run_stack()
        self.assertEqual(self.count("supabase"), 0)

    def test_unmanaged_cache_files_are_not_deleted(self):
        directory = self.root / "cache" / self.project / "supabase"
        directory.mkdir(parents=True)
        sentinel = directory / "config.toml"
        sentinel.write_text("unmanaged fixture")
        with self.assertRaisesRegex(stack.Refusal, "unmanaged files"):
            self.run_stack()
        self.assertEqual(sentinel.read_text(), "unmanaged fixture")
        self.assertEqual(self.count("supabase"), 0)

    def test_tampered_cached_config_cannot_redirect_stop_to_another_project(self):
        self.run_stack()
        cached = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "supabase/config.toml"
        cached.write_text('project_id = "application"\n')
        with self.assertRaisesRegex(stack.Refusal, "config changed"):
            self.run_stack("--stop")
        self.assertEqual(self.count("supabase", "stop"), 0)

    def test_help_never_starts_stack(self):
        self.assertEqual(self.run_stack("--help"), 0)
        self.assertEqual(self.calls, [])

    def test_exclusions_require_restart_not_only_reset(self):
        self.run_stack()
        self.env["INTEGRATION_SUPABASE_EXCLUDE"] = "studio"
        with self.assertRaisesRegex(stack.Refusal, "--stop"):
            self.run_stack("--reset")
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_failed_stop_preserves_ownership_record(self):
        self.run_stack()
        self.fail_command = "stop"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack("--stop")
        self.assertEqual(self.state()["dbId"], "fixture-db-id")

    def test_failed_fresh_cleanup_preserves_workdir_for_recovery(self):
        self.fail_command = "stop"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack("--fresh")
        workdir = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"])
        self.assertTrue((workdir / "supabase/config.toml").exists())

    def test_cleanup_failure_preserves_primary_suite_status_and_reports_recovery(self):
        self.fail_command = "stop"
        self.suite_code = 7
        with mock.patch.object(stack, "say") as output:
            self.assertEqual(self.run_stack("--fresh"), 7)
        self.assertTrue(any("Cleanup failed" in call.args[0] for call in output.call_args_list))
        self.assertTrue(Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]).exists())

    def test_cleanup_failure_preserves_primary_start_exception(self):
        original_command = self.command
        stop_kwargs = []
        def fail_start_and_stop(args, **kwargs):
            if args[:2] in (["supabase", "start"], ["supabase", "stop"]):
                if args[1] == "stop":
                    stop_kwargs.append(kwargs)
                raise subprocess.CalledProcessError(9 if args[1] == "start" else 8, args)
            return original_command(args, **kwargs)
        with mock.patch.object(stack.subprocess, "check_call", fail_start_and_stop):
            with self.assertRaises(subprocess.CalledProcessError) as error:
                self.run_stack("--fresh")
        self.assertEqual(error.exception.cmd[:2], ["supabase", "start"])
        self.assertEqual(error.exception.returncode, 9)
        self.assertNotIn("stderr", stop_kwargs[0], "cleanup diagnostics must remain visible")

    def test_cleanup_failure_preserves_primary_signal_exit(self):
        self.fail_command = "stop"
        with mock.patch.object(stack.subprocess, "call", side_effect=SystemExit(143)):
            with self.assertRaises(SystemExit) as error:
                self.run_stack("--fresh")
        self.assertEqual(error.exception.code, 143)

    def test_cleanup_failure_after_handled_caller_exception_still_fails(self):
        self.fail_command = "stop"
        try:
            raise ValueError("already handled fixture exception")
        except ValueError:
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_stack("--fresh")

    def test_removed_migration_is_removed_from_reset_copy(self):
        self.run_stack()
        original = self.root / "supabase/migrations/20260101000000_fixture.sql"
        original.unlink()
        self.run_stack("--reset")
        copied = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "supabase/migrations" / original.name
        self.assertFalse(copied.exists())

    def test_kept_fresh_stack_advice_names_original_workdir_not_managed_stop(self):
        self.env["INTEGRATION_KEEP_SUPABASE"] = "1"
        self.run_stack("--fresh")
        for args in ((), ("--reuse",), ("--reset",), ("--stop",), ("--fresh",)):
            with self.subTest(args=args), self.assertRaises(stack.Refusal) as error:
                self.run_stack(*args)
            message = str(error.exception)
            self.assertIn("original workdir", message)
            self.assertIn("supabase stop --workdir", message)
            self.assertIn("--stop cannot", message)
        self.assertEqual(self.count("supabase", "stop"), 0)

    def test_owned_stack_advice_offers_reachable_managed_stop(self):
        self.run_stack()
        with self.assertRaises(stack.Refusal) as error:
            self.run_stack("--fresh")
        self.assertIn("--stop before --fresh", str(error.exception))
        self.run_stack("--stop")
        self.assertFalse(self.current)

    def test_copy_excludes_linked_cloud_metadata(self):
        for directory in (".temp", ".branches"):
            source = self.root / "supabase" / directory
            source.mkdir()
            (source / "project-ref").write_text("synthetic-cloud-project")
            (source / "pooler-url").write_text("postgresql://fixture.invalid/fixture")
        self.run_stack()
        copied = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "supabase"
        self.assertFalse((copied / ".temp/project-ref").exists())
        self.assertFalse((copied / ".temp/pooler-url").exists())
        self.assertFalse((copied / ".branches").exists())

    def test_pure_migration_rename_is_drift(self):
        self.run_stack()
        source = self.root / "supabase/migrations/20260101000000_fixture.sql"
        source.rename(source.with_name("20260102000000_fixture.sql"))
        with self.assertRaisesRegex(stack.Refusal, "--reset"):
            self.run_stack()
        self.assertEqual(self.count("bash"), 1)

    def test_symlinked_cache_cannot_reach_outside_its_owned_directory(self):
        self.run_stack()
        cache = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"])
        outside = self.root / "outside-cache-but-still-test-tempdir"
        cache.rename(outside)
        cache.symlink_to(outside, target_is_directory=True)
        sentinel = outside / "supabase/must-not-delete"
        sentinel.write_text("fixture")
        with self.assertRaisesRegex(stack.Refusal, "symlink"):
            self.run_stack("--reset")
        self.assertEqual(sentinel.read_text(), "fixture")
        self.assertEqual(self.count("supabase", "db", "reset"), 1)

    def test_stop_cannot_be_combined_with_reset_or_filters(self):
        self.run_stack()
        for args in (("--stop", "--reset"), ("--stop", "fixture.integration.test.ts")):
            with self.subTest(args=args), self.assertRaises(stack.Refusal):
                self.run_stack(*args)
        self.assertEqual(self.count("supabase", "stop"), 0)

    def test_foreign_state_is_preserved_even_without_live_containers(self):
        self.run_stack()
        path = self.root / "cache" / self.project / "state.json"
        state = self.state()
        state["project"] = "pcp-integration-sibling"
        path.write_text(json.dumps(state))
        self.current = {}
        with self.assertRaisesRegex(stack.Refusal, "different project"):
            self.run_stack("--stop")
        self.assertTrue(path.exists())

    def test_missing_commands_fail_before_any_stack_operation(self):
        for missing in ("docker", "supabase", "bash", "yarn"):
            with self.subTest(missing=missing), \
                 mock.patch.object(stack.shutil, "which", side_effect=lambda name: None if name == missing else "mock"), \
                 self.assertRaisesRegex(stack.Refusal, missing):
                self.run_stack()
        self.assertEqual(self.calls, [])

    def test_docker_daemon_down_explains_how_to_recover(self):
        def check(args, **kwargs):
            self.assertEqual(args, ["docker", "info"])
            raise subprocess.CalledProcessError(1, args)
        with mock.patch.object(stack.subprocess, "check_call", check):
            with self.assertRaisesRegex(stack.Refusal, "Docker Desktop"):
                self.run_stack()
        self.assertEqual(self.count("supabase"), 0)

    def test_cold_reset_preserves_metadata_written_by_start(self):
        original_command = self.command
        def start_writes_metadata(args, **kwargs):
            result = original_command(args, **kwargs)
            if args[:2] == ["supabase", "start"]:
                workdir = Path(args[args.index("--workdir") + 1])
                (workdir / "supabase/.temp").mkdir()
                (workdir / "supabase/.temp/runtime-marker").write_text("fixture")
            return result
        with mock.patch.object(stack.subprocess, "check_call", start_writes_metadata):
            self.run_stack()
        self.assertTrue((Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "supabase/.temp/runtime-marker").exists())


class PrimitiveTests(unittest.TestCase):
    def test_empty_source_arguments_do_not_become_harness_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            harness = Path(directory) / "harmless-suite.sh"
            harness.write_text('printf "%s\\n" "$#" "$@"\n')
            for args in ([], ["fixture.integration.test.ts"]):
                output = subprocess.check_output(["bash", "-c", 'harness=$1; shift; source "$harness"',
                                                  "integration-db-suite", str(harness), *args], text=True)
                self.assertEqual(output.splitlines()[0], str(len(args)))

    def test_child_inherits_lock_until_it_finishes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            child = None
            try:
                with stack.locks(path, "pcp-integration", [55000]) as fds:
                    # Harmless child waits on its pipe; no executor, DB, or real suite.
                    child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                                             stdin=subprocess.PIPE, pass_fds=fds)
                with self.assertRaises(stack.Refusal) as error:
                    with stack.locks(path, "pcp-integration", [55000]):
                        self.fail("child lost the ownership lock")
                self.assertIn("lsof -nP " + str(path / "port-55000.lock"), str(error.exception))
                self.assertIn("never delete the lock file", str(error.exception))
                child.communicate(timeout=5)
                with stack.locks(path, "pcp-integration", [55000]):
                    pass
            finally:
                if child and child.poll() is None:
                    child.terminate()
                    child.communicate(timeout=5)

    def test_project_namespace_and_ports(self):
        for env in ({"INTEGRATION_SUPABASE_PROJECT_ID": "application"},
                    {"INTEGRATION_SUPABASE_PROJECT_ID": "../pcp-integration"},
                    {"INTEGRATION_SUPABASE_API_PORT": "54321/path"},
                    {"INTEGRATION_SUPABASE_API_PORT": "0"},
                    {"INTEGRATION_SUPABASE_API_PORT": "55422"}):
            with self.assertRaises(stack.Refusal):
                stack.settings(env)

    def test_locks_conflict_on_project_or_ports_and_release_without_unlinking(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            with stack.locks(path, "pcp-integration-a", [55000]):
                for project, ports in (("pcp-integration-a", [55001]),
                                       ("pcp-integration-b", [55000])):
                    with self.assertRaisesRegex(stack.Refusal, "Wait.*sparingly"):
                        with stack.locks(path, project, ports):
                            self.fail("contending lock acquired")
                with stack.locks(path, "pcp-integration-b", [55002]):
                    pass
            with stack.locks(path, "pcp-integration-a", [55000]):
                pass

    def test_busy_port_names_owner_and_wait_guidance(self):
        # Harmless localhost listener; no real executor or Docker call.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with mock.patch.object(stack.shutil, "which", return_value="mock"), \
                 mock.patch.object(stack.subprocess, "run", return_value=mock.Mock(stdout="fixture-owner\n")):
                with self.assertRaisesRegex(stack.Refusal, "fixture-owner.*Wait.*sparingly"):
                    stack.port_preflight([port])

    def test_listener_is_detected_without_docker_or_lsof(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with mock.patch.object(stack.shutil, "which", return_value=None):
                with self.assertRaisesRegex(stack.Refusal, "owner unavailable.*Wait"):
                    stack.port_preflight([listener.getsockname()[1]])

    def test_owner_report_alone_refuses_without_a_listener(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with mock.patch.object(stack.shutil, "which", return_value="mock"), \
             mock.patch.object(stack.subprocess, "run", return_value=mock.Mock(stdout="fixture-owner\n")):
            with self.assertRaisesRegex(stack.Refusal, "fixture-owner"):
                stack.port_preflight([port])

    def test_lsof_owner_report_is_readable_without_docker_or_a_listener(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        with mock.patch.object(stack.shutil, "which", side_effect=lambda name: "mock" if name == "lsof" else None), \
             mock.patch.object(stack.subprocess, "run", return_value=mock.Mock(stdout="p12345\ncfixture-server\n")):
            with self.assertRaisesRegex(stack.Refusal, r"fixture-server \(PID 12345\)"):
                stack.port_preflight([port])

    def test_wildcard_listener_refuses_with_silent_owner_tools(self):
        with socket.socket() as listener:
            listener.bind(("0.0.0.0", 0))
            listener.listen()
            with mock.patch.object(stack.shutil, "which", return_value=None):
                with self.assertRaises(stack.Refusal):
                    stack.port_preflight([listener.getsockname()[1]])

    def test_time_wait_is_not_mistaken_for_a_live_listener(self):
        # Active-close the server end to leave its port in TIME_WAIT. All
        # traffic is a harmless local connection, without an external executor.
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port)) as client:
                accepted, _ = listener.accept()
                accepted.close()
                self.assertEqual(client.recv(1), b"")
        with socket.socket() as control:
            with self.assertRaises(OSError):
                control.bind(("127.0.0.1", port))
        with mock.patch.object(stack.shutil, "which", return_value=None):
            stack.port_preflight([port])


class SignalTests(unittest.TestCase):
    def test_interrupts_unwind_fresh_cleanup(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            for group in (False, True):
                with self.subTest(signal=sig.name, group=group), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / "supabase").mkdir()
                    (root / "supabase/config.toml").write_text(TEST_CONFIG)
                    probe = Path(__file__).parent / "fixtures/integration-stack-signal-probe.py"
                    child = subprocess.Popen([sys.executable, str(probe), str(MODULE_PATH), str(root)],
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                             start_new_session=True)
                    output = ""
                    try:
                        deadline = time.monotonic() + 5
                        while "SIGNAL-PROBE-READY" not in output and child.poll() is None and time.monotonic() < deadline:
                            ready, _, _ = select.select([child.stdout], [], [], 0.1)
                            if ready:
                                output += os.read(child.stdout.fileno(), 65536).decode()
                        self.assertIn("SIGNAL-PROBE-READY", output, "Mock suite never became ready")
                        if group:
                            # The group is a single harmless child, captured at
                            # spawn and verified here; never a process-name kill.
                            self.assertEqual(os.getpgid(child.pid), child.pid)
                            os.killpg(child.pid, sig)
                        else:
                            child.send_signal(sig)
                        stdout, stderr = child.communicate(timeout=5)
                        self.assertTrue((root / "cleanup-ran").exists(), "Interrupt skipped fresh-stack cleanup")
                        self.assertEqual(child.returncode, 128 + sig)
                        self.assertNotIn("Traceback", stderr)
                    finally:
                        if child.poll() is None:
                            child.terminate()
                            child.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
