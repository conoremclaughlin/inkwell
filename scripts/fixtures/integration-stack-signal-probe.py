"""Harmless signal-test child: all external commands and sockets are mocked."""

import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
from unittest import mock

module, root_arg = sys.argv[1:]
sys.path.insert(0, str(Path(module).parent))
import integration_data
root = Path(root_arg)
harness = root / "scripts/test-integration-db-local.sh"
state = {"started": False}


def check_call(args, **kwargs):
    if args == ["docker", "info"]:
        return 0
    if args[:2] == ["supabase", "start"]:
        state["started"] = True
        return 0
    if args[:3] == ["supabase", "db", "reset"]:
        return 0
    if args[:2] == ["supabase", "stop"]:
        (root / "cleanup-ran").write_text("yes")
        return 0
    raise AssertionError("Unexpected mocked command")


def run(args, **kwargs):
    if args[:2] in (["docker", "ps"], ["lsof", "-nP"]):
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
    return subprocess.CompletedProcess(args, check_call(args, **kwargs), stdout="", stderr="")


def check_output(args, **kwargs):
    if args == ["supabase", "--version"]:
        return "2.84.2"
    if args[:2] == ["docker", "ps"]:
        return "fixture-id supabase_db_ink-integration" if state["started"] else ""
    raise AssertionError("Unexpected mocked capture")


def call(args, **kwargs):
    assert args[0] == "bash"
    (root / "suite-ready").write_text("yes")
    print("SIGNAL-PROBE-READY", flush=True)
    signal.pause()
    raise AssertionError("Signal did not interrupt the fake suite")


sys.argv = [module, str(harness), "--fresh"]
with mock.patch.object(integration_data, "capture_baseline", return_value="fixture"), \
     mock.patch.dict(os.environ, {"INTEGRATION_SUPABASE_WORKDIR_BASE": str(root)}, clear=True), \
     mock.patch("pathlib.Path.home", return_value=root), \
     mock.patch("shutil.which", return_value="mock-command"), \
     mock.patch("socket.socket"), \
     mock.patch("subprocess.check_call", check_call), \
     mock.patch("subprocess.run", run), \
     mock.patch("subprocess.check_output", check_output), \
     mock.patch("subprocess.call", call):
    runpy.run_path(module, run_name="__main__")
