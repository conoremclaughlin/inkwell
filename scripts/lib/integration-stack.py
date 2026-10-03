#!/usr/bin/env python3
"""Own the local test stack lifecycle; never manage an application stack.

The shell harness remains responsible for endpoint derivation and the suite.
Only this parent owns cleanup. Its advisory locks outlive the suite subprocess.
"""

import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

from integration_data import (BASELINE_FILE, POLICY, Refusal, capture_baseline,
                              clean_fixtures, finish_run)


PREFIX = "[integration-db] "
PORT_NAMES = ("API", "DB", "STUDIO", "INBUCKET", "INBUCKET_SMTP", "INBUCKET_POP3")
DEFAULT_EXCLUDE = "studio,mailpit,logflare,vector,supavisor"
# The suffix group is what makes a project private.
PROJECT_PATTERN = re.compile(r"(?:ink|pcp)-integration(-[a-zA-Z0-9_-]+)?")
# One shared integration stack is the design. A Supabase stack is about eight
# containers and most of a GiB that stays resident, and a cold start replays
# every migration. The Docker VM on a development machine
# is shared with every other project's stack and is mostly full before a test
# starts. On 2026-10-02 four integration stacks came up in eleven minutes:
# the lock used to refuse a second run, and a new project suffix got past it,
# which is the most expensive way to wait. So a held lock is now waited on,
# and a private stack is an explicit decision (--private-stack): one at a
# time, machine-wide, and stopped after its run unless --reuse keeps it. Use
# one only for a run the shared stack cannot serve, such as a rehearsal with
# withheld migrations (INTEGRATION_MIGRATIONS_UNTIL).
DEFAULT_PROJECT = "ink-integration"
DEFAULT_LOCK_WAIT_SECONDS = 1200
LOCK_REPORT_SECONDS = 60


def say(message):
    print(PREFIX + message, flush=True)


def capture(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def containers(project):
    output = capture(["docker", "ps", "-a", "--filter",
                      "label=com.supabase.cli.project=" + project,
                      "--format", "{{.ID}} {{.Names}}"])
    return dict(line.split(" ", 1)[::-1] for line in output.splitlines())


def settings(env):
    project = env.get("INTEGRATION_SUPABASE_PROJECT_ID", DEFAULT_PROJECT)
    # This namespace is exclusively disposable test data. No app project ID
    # can be selected accidentally through an inherited override.
    # `pcp-integration` is still accepted, and deliberately: a stack created
    # before #659 is named that, and its containers carry
    # com.supabase.cli.project=pcp-integration. Refusing the name would leave
    # an already-running stack with no way to reach it — including --stop.
    # Both prefixes name the same disposable namespace; neither can collide
    # with an app project ID.
    if not PROJECT_PATTERN.fullmatch(project):
        raise Refusal(
            "INTEGRATION_SUPABASE_PROJECT_ID must be ink-integration or "
            "ink-integration-<suffix> (legacy pcp-integration is also accepted)."
        )
    ports = []
    for index, name in enumerate(PORT_NAMES):
        value = env.get("INTEGRATION_SUPABASE_" + name + "_PORT", str(55421 + index))
        if not value.isascii() or not value.isdigit() or not 1024 <= int(value) <= 65535:
            raise Refusal("Invalid INTEGRATION_SUPABASE_" + name + "_PORT; expected 1024..65535.")
        ports.append(int(value))
    if len(set(ports)) != len(ports):
        raise Refusal("Integration stack ports must be distinct.")
    return project, ports, env.get("INTEGRATION_SUPABASE_EXCLUDE", DEFAULT_EXCLUDE)


def lock_wait(env):
    value = env.get("INTEGRATION_LOCK_WAIT_SECONDS", str(DEFAULT_LOCK_WAIT_SECONDS))
    if not value.isascii() or not value.isdigit():
        raise Refusal("Invalid INTEGRATION_LOCK_WAIT_SECONDS; expected whole seconds (0 refuses at once).")
    return int(value)


def private_stacks():
    """Projects of the private integration stacks running on this machine."""
    output = capture(["docker", "ps", "--filter", "label=com.supabase.cli.project",
                      "--format", '{{.Label "com.supabase.cli.project"}}'])
    matches = (PROJECT_PATTERN.fullmatch(name) for name in output.splitlines())
    return {match[0] for match in matches if match and match[1]}


@contextlib.contextmanager
def locks(directory, project, ports, wait=0, private=False, checkout=None, poll=2.0):
    directory.mkdir(parents=True, exist_ok=True)
    # Project lock also covers callers that override ports. Port locks
    # cover callers with different project IDs but overlapping ports. The
    # private-stack lock is one slot for the whole machine.
    keys = ["project-" + project] + ["port-" + str(p) for p in ports]
    if private:
        keys.append("private-stack")
    label = ("runner/descendant lock from PID " + str(os.getpid()) + ", project " + project +
             (", checkout " + str(checkout) if checkout else ""))
    started = time.monotonic()
    with contextlib.ExitStack() as stack:
        handles = []
        # Every caller takes its keys in one sorted order, so two waiters
        # cannot each hold a key the other is waiting for.
        for key in sorted(keys):
            path = directory / (key + ".lock")
            handle = stack.enter_context(path.open("a+"))
            reported = None
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    handle.seek(0)
                    owner = handle.read().strip() or "holder not yet recorded"
                waited = time.monotonic() - started
                if waited >= wait:
                    raise Refusal("Another integration run holds " + key + " (" + owner + ")" +
                                  (" and still held it after " + str(int(waited)) + "s" if wait else "") + ". "
                                  "Wait for that run to finish and retry; run DB integration tests sparingly. "
                                  "Do not start a private stack to get around a held lock. "
                                  "Find the actual holder (which may be a surviving descendant) with: lsof -nP " +
                                  shlex.quote(str(path)) + ". "
                                  "See CONTRIBUTING.md for orphan recovery; never delete the lock file.")
                if reported is None or time.monotonic() - reported >= LOCK_REPORT_SECONDS:
                    say(("Waiting up to " + str(wait) + "s for " if reported is None else
                         "Still waiting (" + str(int(waited)) + "s) for ") + key + "; held by " + owner)
                    reported = time.monotonic()
                time.sleep(min(poll, max(wait - waited, 0)))
            handle.seek(0)
            handle.truncate()
            handle.write(label + ", since " + datetime.now(timezone.utc).isoformat(timespec="seconds"))
            handle.flush()
            handles.append(handle)
        # Do not unlink lock files: waiters may still reference their inodes.
        yield [handle.fileno() for handle in handles]


def port_preflight(ports):
    for port in ports:
        owners = []
        if shutil.which("docker"):
            result = subprocess.run(["docker", "ps", "--filter", "publish=" + str(port),
                                     "--format", "{{.Names}}"], capture_output=True, text=True)
            owners.extend(result.stdout.splitlines())
        if shutil.which("lsof"):
            result = subprocess.run(["lsof", "-nP", "-iTCP:" + str(port),
                                     "-sTCP:LISTEN", "-Fpc"], capture_output=True, text=True)
            pid = "unknown"
            for field in result.stdout.splitlines():
                if field.startswith("p") and field[1:].isdigit():
                    pid = field[1:]
                elif field.startswith("c"):
                    owners.append(field[1:] + " (PID " + pid + ")")
        unavailable = bool(owners)
        # On macOS, REUSEADDR lets this probe bind past a client socket that
        # holds the port, open or in TIME_WAIT. On Linux it does not: a client
        # whose ephemeral local port is ours refuses the probe in both states,
        # with no listener for lsof to name ("owner unavailable"). CI reserves
        # the ports from the ephemeral range for that reason (ci.yml). On macOS
        # a wildcard bind can coexist with a loopback bind, so probe each exact
        # loopback as well as the wildcard listeners.
        for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET, "0.0.0.0"),
                             (socket.AF_INET6, "::1"), (socket.AF_INET6, "::")):
            if unavailable:
                break
            try:
                with socket.socket(family) as sock:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    if family == socket.AF_INET6:
                        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    sock.bind((host, port))
                    sock.listen(1)
            except OSError as error:
                import errno
                if family == socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL):
                    continue
                unavailable = True
        if unavailable:
            owner = ", ".join(owners) or "owner unavailable"
            raise Refusal("Port " + str(port) + " is unavailable (" + owner + "). "
                          "Wait for its owner to finish and retry; do not stop another stack. "
                          "Run DB integration tests sparingly.")


def configuration(root, project, ports):
    text = (root / "supabase/config.toml").read_text()
    fields = (("api", "port"), ("db", "port"), ("studio", "port"),
              ("inbucket", "port"), ("inbucket", "smtp_port"), ("inbucket", "pop3_port"))
    expected = dict(zip(fields, zip(range(54321, 54327), ports)))
    seen = set()
    section = ""
    lines = []
    # Validate the source shape before starting any containers. Rewrite by
    # section/key in one pass so overrides cannot cascade through other ports.
    for line in text.splitlines(keepends=True):
        header = re.match(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$", line)
        if header:
            section = header[1]
        field = re.match(r"^(\s*(\w+)\s*=\s*)([^#\r\n]*)(.*)$", line)
        key = (section, field[2]) if field else None
        if key in expected:
            default, replacement = expected[key]
            if key in seen or field[3].strip() != str(default):
                raise Refusal("Unexpected or duplicate port in [" + section + "]." + key[1] +
                              "; restore config.toml defaults and use INTEGRATION_SUPABASE_*_PORT overrides.")
            seen.add(key)
            line = line[:field.start(3)] + str(replacement) + line[field.start(3) + len(str(default)):]
        lines.append(line)
    if seen != set(expected):
        missing = ", ".join("[" + section + "]." + key for section, key in sorted(set(expected) - seen))
        raise Refusal("Missing expected ports in config.toml: " + missing +
                      "; refusing to start an incompletely isolated stack.")
    text = "".join(lines)
    if re.search(r"(?m)^project_id\s*=", text):
        text = re.sub(r"(?m)^project_id\s*=.*$", 'project_id = "' + project + '"', text)
    else:
        text = 'project_id = "' + project + '"\n' + text
    return text


def fingerprint(root, config, exclude, version, until=""):
    digest = hashlib.sha256()
    # `until` is the rehearsal cut (INTEGRATION_MIGRATIONS_UNTIL): a stack built
    # at the older schema must never be reused for a full-schema run, or the
    # reverse, so the cut is part of what makes two stacks the same.
    for value in (config, exclude, version, POLICY, until):
        digest.update(value.encode() + b"\0")
    # Include file names as well as contents: rename/removal is schema drift.
    for path in sorted((root / "supabase").rglob("*.sql")):
        if any(part in (".temp", ".branches") for part in path.parts):
            continue
        digest.update(str(path.relative_to(root)).encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def prepare(root, workdir, config, until=None):
    target = workdir / "supabase"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(root / "supabase", target, ignore=shutil.ignore_patterns(".temp", ".branches"))
    (target / "config.toml").write_text(config)
    # Rehearsal mode (spec inkmail-thread-scope §4): withhold every migration at
    # or after a timestamp so the stack comes up at the OLDER schema, and a test
    # can execute a withheld migration file itself — inside a transaction it
    # rolls back — against fixtures it seeded. The withheld files are read from
    # the real repository (INTEGRATION_MIGRATIONS_DIR), never from this copy.
    if until:
        withheld = 0
        for migration in sorted((target / "migrations").glob("*.sql")):
            stamp = migration.name.split("_", 1)[0]
            if stamp >= until:
                migration.unlink()
                withheld += 1
        say("Rehearsal: applying migrations before " + until + " (" + str(withheld) + " withheld)")


def read_state(path):
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text())
        if not isinstance(state, dict):
            raise ValueError()
        return state
    except (ValueError, OSError):
        raise Refusal("Retained stack state is unreadable; refusing to adopt or stop it.")


def write_state(path, state):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state))
    temp.replace(path)


def manage(root, harness, args, env):
    if "--help" in args or "-h" in args:
        say("Usage: yarn test:integration:db:local [--reuse|--fresh] [--reset|--stop] [--private-stack] [vitest filters]")
        say("Local default: the shared retained test stack. CI default: fresh stack. --reset reapplies migrations + seed.")
        say("A held lock is waited on (INTEGRATION_LOCK_WAIT_SECONDS, default " +
            str(DEFAULT_LOCK_WAIT_SECONDS) + "), then refused.")
        say("--private-stack allows an " + DEFAULT_PROJECT + "-<suffix> project: one at a time, stopped after "
            "its run unless --reuse. Only for a run the shared stack cannot serve.")
        say("--stop releases an owned retained stack. Warm runs clean scoped fixture data; run tests sparingly.")
        return 0
    project, ports, exclude = settings(env)
    lifecycle = None
    reset = stop = private_flag = False
    suite_args = []
    for arg in args:
        if arg == "--fresh":
            lifecycle = "fresh"
        elif arg == "--reuse":
            lifecycle = "reuse"
        elif arg == "--reset":
            reset = True
        elif arg == "--stop":
            stop = True
        elif arg == "--private-stack":
            private_flag = True
        else:
            suite_args.append(arg)
    if stop and (reset or suite_args):
        raise Refusal("--stop cannot be combined with --reset or test arguments.")
    # Legacy support is STOP-ONLY, and the refusal has to happen here — before
    # the lock, before docker, before anything reads or mutates state.
    # settings() accepts the pre-rename name so an orphaned stack can be shut
    # down, but the rest of the harness is not legacy-aware: validate_identity
    # requires an ink-integration name, and the bookkeeping schema is _ink_it
    # where an old stack has _pcp_it. Running a suite or a reset against one
    # would fail somewhere deeper, after work had already begun.
    if project.startswith("pcp-") and not stop:
        raise Refusal(
            "Project " + project + " is the pre-rename name and is supported for --stop "
            "only. Stop it with: INTEGRATION_SUPABASE_PROJECT_ID=" + project +
            " yarn test:integration:db:local --stop, then run again without the "
            "override to create a current stack.")
    # See DEFAULT_PROJECT for why a second stack is a decision, not a reflex.
    # Stopping one never needs the flag: it only gives memory back.
    private = project != DEFAULT_PROJECT
    if private and not stop and not private_flag:
        raise Refusal(
            "Project " + project + " would start a private stack beside the shared " + DEFAULT_PROJECT +
            ". One shared stack is deliberate: each extra stack holds most of a GiB of Docker memory and "
            "replays every migration on a cold start. Run without INTEGRATION_SUPABASE_PROJECT_ID, and the "
            "harness waits for a busy shared stack instead of refusing. If the shared stack cannot serve "
            "this run (withheld migrations, for example), pass --private-stack.")
    if lifecycle:
        fresh = lifecycle == "fresh"
    else:
        # A private stack is disposable unless --reuse asks to keep it.
        fresh = private or env.get("CI", "").lower() in ("1", "true")
    base = Path(env.get("INTEGRATION_SUPABASE_CACHE_DIR", str(Path.home() / ".cache/inkwell/integration-db")))
    # Locks are machine-wide even when a caller selects a different cache dir.
    lock_dir = Path.home() / ".cache/inkwell/integration-db-locks"
    with locks(lock_dir, project, ports, wait=lock_wait(env), private=private and not stop,
               checkout=root) as lock_fds:
        for command in ("docker", "supabase", "bash", "yarn"):
            if not shutil.which(command):
                raise Refusal(command + " is required.")
        try:
            subprocess.check_call(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            raise Refusal("Docker daemon is unavailable. Start Docker Desktop (or your Docker daemon), then retry.")
        existing = containers(project)
        if private and not stop:
            # The private-stack lock bounds concurrent runs; a retained or
            # kept stack outlives its run, so count the running ones too.
            others = sorted(private_stacks() - {project})
            if others:
                raise Refusal(
                    "A private integration stack is already running (" + ", ".join(others) + "), and the "
                    "machine-wide cap is one. Use the shared stack, or wait for that one to be released. "
                    "If it is yours: INTEGRATION_SUPABASE_PROJECT_ID=" + others[0] +
                    " yarn test:integration:db:local --stop. Never stop someone else's run.")
        cache = base / project
        state_path = cache / "state.json"
        state = read_state(state_path)
        if cache.is_symlink() or (cache / "supabase").is_symlink():
            raise Refusal("Refusing a symlinked stack workdir.")
        if state and state.get("project") != project:
            raise Refusal("Retained state names a different project; refusing to modify it.")
        if not state and cache.exists() and any(cache.iterdir()):
            raise Refusal("Stack cache contains unmanaged files; refusing to replace them.")
        if state:
            cached_config = cache / "supabase/config.toml"
            if not cached_config.exists() or cached_config.read_text() != state.get("config"):
                raise Refusal("Retained stack config changed outside the harness; refusing to run or stop it.")
        db_name = "supabase_db_" + project
        recorded = state.get("containers", {}) if state else {}
        known_survivors = isinstance(recorded, dict) and all(
            recorded.get(name) == container_id for name, container_id in existing.items())
        owned = bool(state and state.get("project") == project and existing and (
            (existing.get(db_name) and state.get("dbId") == existing.get(db_name)) or
            (not existing.get(db_name) and known_survivors)
        ))
        if existing and not owned:
            raise Refusal("Project " + project + " already exists but is not owned by this cache: " +
                          ", ".join(sorted(existing)) + ". Wait for its owner and retry; --stop cannot "
                          "recover an unmanaged stack. If this is your kept inspection stack, use its "
                          "original workdir with: supabase stop --workdir <original-workdir> --no-backup. "
                          "Never stop someone else's run.")
        if owned and not existing.get(db_name) and not stop:
            raise Refusal("Owned DB container is missing. Use --stop to remove its verified surviving "
                          "containers, then retry to recreate the test stack.")
        if existing and fresh and not stop:
            raise Refusal("Project " + project + " already exists: " + ", ".join(sorted(existing)) +
                          ". Wait and retry. A retained stack owned by this harness can be reused "
                          "with --reuse or stopped with --stop before --fresh. Never stop someone else's run.")
        if stop:
            # A stack retained before #659 is named pcp-integration and lives
            # under its own cache dir, so a default --stop looks at
            # ink-integration, finds nothing, and reports success while the
            # old containers keep running. Say so instead of exiting 0.
            if not owned and not state and project.startswith("ink-"):
                legacy_project = "pcp-" + project[len("ink-"):]
                if containers(legacy_project):
                    raise Refusal(
                        "Nothing to stop under " + project + ", but a pre-rename stack "
                        + legacy_project + " is still running. Stop it by name: "
                        "INTEGRATION_SUPABASE_PROJECT_ID=" + legacy_project +
                        " yarn test:integration:db:local --stop")
            if owned:
                say("Stopping the retained test stack " + project)
                subprocess.check_call(["supabase", "stop", "--workdir", str(cache), "--no-backup"],
                                      stdout=subprocess.DEVNULL)
            if state:
                shutil.rmtree(cache / "supabase")
                state_path.unlink()
                for name in (BASELINE_FILE, "run.json"):
                    (cache / name).unlink(missing_ok=True)
            return 0
        config = configuration(root, project, ports)
        version = capture(["supabase", "--version"])
        until = env.get("INTEGRATION_MIGRATIONS_UNTIL") or ""
        signature = fingerprint(root, config, exclude, version, until)
        if existing and (state.get("config") != config or state.get("exclude") != exclude or state.get("version") != version):
            raise Refusal("Retained stack ports/config/CLI differ. Use --stop, then retry.")
        if existing and state.get("fingerprint") != signature and not reset:
            raise Refusal("Retained stack schema/seed/CLI settings differ. Run --reset to prepare this checkout "
                          "once, then reuse it. Do not repeatedly reset stacks across branches.")
        if not existing:
            port_preflight(ports)
        workdir = Path(tempfile.mkdtemp(prefix="ink-supabase-it-", dir=env.get("INTEGRATION_SUPABASE_WORKDIR_BASE"))) if fresh else cache
        workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        say("Test workdir=" + str(workdir))
        marker_path = workdir / "run.json"
        if marker_path.exists():
            say("Previous run did not complete successfully; preparing fixture data before retry. "
                "The marker is diagnostic, not a lock; never delete lock files to force a run.")
        marker = {"runId": str(uuid.uuid4()), "project": project, "pid": os.getpid(),
                  "startedAt": datetime.now(timezone.utc).isoformat(), "phase": "preparing"}
        write_state(marker_path, marker)
        baseline_state = state.get("baseline") if state else None
        db_id = existing.get(db_name)
        started = False
        ready = False
        suite_code = 0
        primary_error = False
        keep = not fresh or env.get("INTEGRATION_KEEP_SUPABASE") == "1"
        try:
            if not existing:
                prepare(root, workdir, config, until)
                say("Starting test stack " + project)
                started = True
                subprocess.check_call(["supabase", "start", "--workdir", str(workdir), "--exclude", exclude],
                                      stdout=subprocess.DEVNULL, pass_fds=lock_fds)
                ready = True
            else:
                say("Reusing test stack " + project + " (no container recreation)")
            if not fresh:
                snapshot = containers(project)
                if existing and snapshot.get(db_name) != db_id:
                    raise Refusal("Database container changed after ownership validation; refusing to adopt it.")
                state = {"project": project, "dbId": snapshot.get(db_name), "containers": snapshot,
                         "config": config, "exclude": exclude, "version": version,
                         "fingerprint": signature if existing and not reset else None,
                         "baseline": baseline_state}
                write_state(state_path, state)
            if fresh or reset or not existing:
                if existing:
                    prepare(root, workdir, config, until)
                say("Resetting test DB (migrations + seed)")
                try:
                    subprocess.check_call(["supabase", "db", "reset", "--workdir", str(workdir), "--local"],
                                          stdout=subprocess.DEVNULL, pass_fds=lock_fds)
                finally:
                    # Reset recreates Postgres. Even a failed reset can replace
                    # its ID; retain ownership, but never a ready fingerprint.
                    if not fresh:
                        after_reset = containers(project)
                        state.update(dbId=after_reset.get(db_name), containers=after_reset)
                        write_state(state_path, state)
                db_id = containers(project).get(db_name)
                baseline_state = capture_baseline(workdir, project, db_id, ports[1], lock_fds,
                                                  signature, marker["runId"], until)
            else:
                marker["phase"] = "cleaning"
                write_state(marker_path, marker)
                say("Cleaning allowlisted fixture tables (not resetting the database or containers)")
                clean_fixtures(workdir, project, db_id, ports[1], baseline_state, lock_fds,
                               signature, marker["runId"], until)
            if containers(project).get(db_name) != db_id:
                raise Refusal("Database container changed during fixture preparation; suite not started.")
            if not fresh:
                state.update(dbId=db_id, fingerprint=signature,
                             baseline=baseline_state)
                write_state(state_path, state)
            suite_env = dict(env, INTEGRATION_MANAGED_WORKDIR=str(workdir),
                             INTEGRATION_MIGRATIONS_DIR=str(root / "supabase" / "migrations"),
                             INTEGRATION_MANAGED_API_PORT=str(ports[0]),
                             INTEGRATION_MANAGED_DB_PORT=str(ports[1]))
            marker["phase"] = "testing"
            write_state(marker_path, marker)
            say("Run focused DB tests sparingly; fixture cleanup does not repair schema drift. Use --reset if needed.")
            suite_code = subprocess.call(["bash", "-c", 'harness=$1; shift; source "$harness"', "integration-db-suite", str(harness), *suite_args], env=suite_env, pass_fds=lock_fds)
            if suite_code == 0:
                finish_run(project, db_id, ports[1], baseline_state, lock_fds, signature, marker["runId"])
                marker_path.unlink()
            return suite_code
        except BaseException:
            # Include signal exits, but not a handled exception in our caller.
            primary_error = True
            raise
        finally:
            if started and (not keep or not ready):
                say("Stopping test stack; if cleanup fails, preserve this workdir for recovery: " + str(workdir))
                try:
                    subprocess.check_call(["supabase", "stop", "--workdir", str(workdir), "--no-backup"],
                                          stdout=subprocess.DEVNULL)
                except (OSError, subprocess.CalledProcessError):
                    say("Cleanup failed; workdir preserved for manual recovery: " + str(workdir))
                    # Cleanup must fail an otherwise successful run, but must
                    # not replace a startup exception, signal, or suite status.
                    if not primary_error and suite_code == 0:
                        raise
                else:
                    shutil.rmtree(workdir)
            elif keep:
                say("Retained test stack; workdir=" + str(workdir))
                if fresh:
                    say("Release inspection stack: supabase stop --workdir " + shlex.quote(str(workdir)) + " --no-backup")
                else:
                    prefix = "INTEGRATION_SUPABASE_PROJECT_ID=" + project + " "
                    if "INTEGRATION_SUPABASE_CACHE_DIR" in env:
                        prefix += "INTEGRATION_SUPABASE_CACHE_DIR=" + shlex.quote(str(base)) + " "
                    say("Release it when no longer needed: " + prefix + "yarn test:integration:db:local --stop")


if __name__ == "__main__":
    # Unlike SIGINT, Python's default SIGTERM action does not unwind finally.
    # SystemExit preserves the signal exit code while running owned cleanup.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        harness = Path(sys.argv[1]).resolve()
        sys.exit(manage(harness.parent.parent, harness, sys.argv[2:], os.environ))
    except Refusal as error:
        print(PREFIX + str(error), file=sys.stderr)
        sys.exit(75)
    except subprocess.CalledProcessError:
        print(PREFIX + "Stack command failed; inspect the preceding phase and workdir for recovery.", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print(PREFIX + "Interrupted; owned cleanup has run (retained mode keeps its stack).", file=sys.stderr)
        sys.exit(130)
