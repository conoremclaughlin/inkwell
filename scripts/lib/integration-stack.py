#!/usr/bin/env python3
"""Own the local test stack lifecycle; never manage an application stack.

The shell harness remains responsible for endpoint derivation and the suite.
Only this parent owns cleanup. Its advisory locks outlive the suite subprocess.
"""

import contextlib
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


PREFIX = "[integration-db] "
PORT_NAMES = ("API", "DB", "STUDIO", "INBUCKET", "INBUCKET_SMTP", "INBUCKET_POP3")
DEFAULT_EXCLUDE = "studio,mailpit,logflare,vector,supavisor"


class Refusal(Exception):
    pass


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
    project = env.get("INTEGRATION_SUPABASE_PROJECT_ID", "pcp-integration")
    # This namespace is exclusively disposable test data. No app project ID
    # can be selected accidentally through an inherited override.
    if not re.fullmatch(r"pcp-integration(?:-[a-zA-Z0-9_-]+)?", project):
        raise Refusal("INTEGRATION_SUPABASE_PROJECT_ID must be pcp-integration or pcp-integration-<suffix>.")
    ports = []
    for index, name in enumerate(PORT_NAMES):
        value = env.get("INTEGRATION_SUPABASE_" + name + "_PORT", str(55421 + index))
        if not value.isascii() or not value.isdigit() or not 1024 <= int(value) <= 65535:
            raise Refusal("Invalid INTEGRATION_SUPABASE_" + name + "_PORT; expected 1024..65535.")
        ports.append(int(value))
    if len(set(ports)) != len(ports):
        raise Refusal("Integration stack ports must be distinct.")
    return project, ports, env.get("INTEGRATION_SUPABASE_EXCLUDE", DEFAULT_EXCLUDE)


@contextlib.contextmanager
def locks(directory, project, ports):
    directory.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        handles = []
        # Project lock also covers callers that override ports. Port locks
        # cover callers with different project IDs but overlapping ports.
        for key in sorted(["project-" + project] + ["port-" + str(p) for p in ports]):
            handle = stack.enter_context((directory / (key + ".lock")).open("a+"))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.seek(0)
                owner = handle.read().strip()
                raise Refusal("Another integration run holds " + key + " (" + owner + "). "
                              "Wait for that run to finish and retry; run DB integration tests sparingly. "
                              "Find the actual holder (which may be a surviving descendant) with: lsof -nP " +
                              shlex.quote(str(directory / (key + ".lock"))) + ". "
                              "See CONTRIBUTING.md for orphan recovery; never delete the lock file.")
            handle.seek(0)
            handle.truncate()
            handle.write("runner/descendant lock from PID " + str(os.getpid()) + ", project " + project)
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
        # REUSEADDR avoids treating a completed client's TIME_WAIT socket as
        # a server. On macOS a wildcard bind can coexist with a loopback bind,
        # so probe each exact loopback as well as the wildcard listeners.
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


def fingerprint(root, config, exclude, version):
    digest = hashlib.sha256()
    for value in (config, exclude, version):
        digest.update(value.encode() + b"\0")
    # Include file names as well as contents: rename/removal is schema drift.
    for path in sorted((root / "supabase").rglob("*.sql")):
        if any(part in (".temp", ".branches") for part in path.parts):
            continue
        digest.update(str(path.relative_to(root)).encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def prepare(root, workdir, config):
    target = workdir / "supabase"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(root / "supabase", target, ignore=shutil.ignore_patterns(".temp", ".branches"))
    (target / "config.toml").write_text(config)


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
        say("Usage: yarn test:integration:db:local [--reuse|--fresh] [--reset|--stop] [vitest filters]")
        say("Local default: retained test stack. CI default: fresh stack. --reset reapplies migrations + seed.")
        say("--stop releases an owned retained stack. Warm runs retain data; run focused integration tests sparingly.")
        return 0
    project, ports, exclude = settings(env)
    fresh = env.get("CI", "").lower() in ("1", "true")
    reset = stop = False
    suite_args = []
    for arg in args:
        if arg == "--fresh":
            fresh = True
        elif arg == "--reuse":
            fresh = False
        elif arg == "--reset":
            reset = True
        elif arg == "--stop":
            stop = True
        else:
            suite_args.append(arg)
    if stop and (reset or suite_args):
        raise Refusal("--stop cannot be combined with --reset or test arguments.")
    base = Path(env.get("INTEGRATION_SUPABASE_CACHE_DIR", str(Path.home() / ".cache/inkwell/integration-db")))
    # Locks are machine-wide even when a caller selects a different cache dir.
    lock_dir = Path.home() / ".cache/inkwell/integration-db-locks"
    with locks(lock_dir, project, ports) as lock_fds:
        for command in ("docker", "supabase", "bash", "yarn"):
            if not shutil.which(command):
                raise Refusal(command + " is required.")
        try:
            subprocess.check_call(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError:
            raise Refusal("Docker daemon is unavailable. Start Docker Desktop (or your Docker daemon), then retry.")
        existing = containers(project)
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
            if owned:
                say("Stopping the retained test stack " + project)
                subprocess.check_call(["supabase", "stop", "--workdir", str(cache), "--no-backup"],
                                      stdout=subprocess.DEVNULL)
            if state:
                shutil.rmtree(cache / "supabase")
                state_path.unlink()
            return 0
        config = configuration(root, project, ports)
        version = capture(["supabase", "--version"])
        signature = fingerprint(root, config, exclude, version)
        if existing and (state.get("config") != config or state.get("exclude") != exclude or state.get("version") != version):
            raise Refusal("Retained stack ports/config/CLI differ. Use --stop, then retry.")
        if existing and state.get("fingerprint") != signature and not reset:
            raise Refusal("Retained stack schema/seed/CLI settings differ. Run --reset to prepare this checkout "
                          "once, then reuse it. Do not repeatedly reset stacks across branches.")
        if not existing:
            port_preflight(ports)
        workdir = Path(tempfile.mkdtemp(prefix="pcp-supabase-it-", dir=env.get("INTEGRATION_SUPABASE_WORKDIR_BASE"))) if fresh else cache
        workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        say("Test workdir=" + str(workdir))
        started = False
        ready = False
        suite_code = 0
        primary_error = False
        keep = not fresh or env.get("INTEGRATION_KEEP_SUPABASE") == "1"
        try:
            if not existing:
                prepare(root, workdir, config)
                say("Starting test stack " + project)
                started = True
                subprocess.check_call(["supabase", "start", "--workdir", str(workdir), "--exclude", exclude],
                                      stdout=subprocess.DEVNULL, pass_fds=lock_fds)
                ready = True
            else:
                say("Reusing test stack " + project + " (no container recreation)")
            if not fresh:
                snapshot = containers(project)
                state = {"project": project, "dbId": snapshot.get(db_name), "containers": snapshot,
                         "config": config, "exclude": exclude, "version": version, "fingerprint": None}
                write_state(state_path, state)
            if fresh or reset or not existing:
                if existing:
                    prepare(root, workdir, config)
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
            if not fresh:
                state.update(dbId=containers(project).get(db_name), fingerprint=signature)
                write_state(state_path, state)
            suite_env = dict(env, INTEGRATION_MANAGED_WORKDIR=str(workdir),
                             INTEGRATION_MANAGED_API_PORT=str(ports[0]),
                             INTEGRATION_MANAGED_DB_PORT=str(ports[1]))
            say("Run focused DB tests sparingly; warm runs retain data. Use --reset for a pristine test DB.")
            suite_code = subprocess.call(["bash", "-c", 'harness=$1; shift; source "$harness"', "integration-db-suite", str(harness), *suite_args], env=suite_env, pass_fds=lock_fds)
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
