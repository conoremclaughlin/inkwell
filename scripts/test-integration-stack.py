#!/usr/bin/env python3
"""Lifecycle tests. Docker, Supabase, Yarn, and suite execution are all mocked."""

import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("stack", Path(__file__).parent / "lib/integration-stack.py")
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "supabase/migrations").mkdir(parents=True)
        (self.root / "supabase/config.toml").write_text("[api]\nport = 54321\n[db]\nport = 54322\n")
        (self.root / "supabase/migrations/20260101000000_fixture.sql").write_text("select 1;")
        self.harness = self.root / "scripts/test-integration-db-local.sh"
        self.env = {"INTEGRATION_SUPABASE_CACHE_DIR": str(self.root / "cache"),
                    "INTEGRATION_SUPABASE_WORKDIR_BASE": str(self.root)}
        self.project = "pcp-integration"
        self.db = "supabase_db_" + self.project
        self.current = {}
        self.calls = []
        self.fail = None
        self.suite_code = 0
        for target, replacement in (
            ("capture", self.capture), ("containers", lambda _: dict(self.current)),
            ("port_preflight", lambda _: self.calls.append(["preflight"])),
            ("say", lambda _: None),
        ):
            patch = mock.patch.object(stack, target, replacement)
            patch.start()
            self.addCleanup(patch.stop)
        for target, replacement in (
            ("check_call", self.command), ("run", self.command), ("call", self.suite),
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
        if args[1] == self.fail:
            raise subprocess.CalledProcessError(1, args)
        if args[1] == "start":
            self.current = {self.db: "fixture-db-id"}
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
        self.fail = "db"
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
        self.fail = "start"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack()
        self.assertEqual(self.count("supabase", "stop"), 1)
        self.assertEqual(self.count("bash"), 0)

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
        self.fail = "stop"
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stack("--stop")
        self.assertEqual(self.state()["dbId"], "fixture-db-id")

    def test_removed_migration_is_removed_from_reset_copy(self):
        self.run_stack()
        original = self.root / "supabase/migrations/20260101000000_fixture.sql"
        original.unlink()
        self.run_stack("--reset")
        copied = Path(self.suite_env["INTEGRATION_MANAGED_WORKDIR"]) / "supabase/migrations" / original.name
        self.assertFalse(copied.exists())


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
                with self.assertRaises(stack.Refusal):
                    with stack.locks(path, "pcp-integration", [55000]):
                        self.fail("child lost the ownership lock")
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


if __name__ == "__main__":
    unittest.main()
