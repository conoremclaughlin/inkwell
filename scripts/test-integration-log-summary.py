#!/usr/bin/env python3
"""Synthetic logs and fake executables; no Docker daemon or live database."""
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('summary', ROOT / 'lib/integration-log-summary.py')
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)
STAMP = '2026-01-01T00:00:00.000000000Z '


class LogSummaryTests(unittest.TestCase):
    def parse(self, value, service='kong'):
        rows = []
        summary.summarize(io.StringIO(value), service, rows.append)
        return rows

    def test_failure_survives_more_than_150_later_accesses(self):
        bad = STAMP + 'client "POST /rest/v1/rpc/probe?token=fixture-hidden HTTP/1.1" 502 20 "-" "node"\n'
        good = STAMP + 'client "GET /rest/v1/probe HTTP/1.1" 200 2 "-" "node"\n'
        rows = self.parse(bad + good * 200)
        self.assertEqual(rows[0]['status'], 502)
        self.assertEqual(rows[-1]['counts']['http_200'], 200)
        self.assertNotIn('fixture-hidden', json.dumps(rows))

    def test_upstream_close_and_reset_preserve_cause_without_request(self):
        for message, expected in summary.TRANSPORT.items():
            with self.subTest(message=message):
                rows = self.parse(STAMP + '[error] ' + message + ', request: "PATCH /private-fixture?secret=fixture-hidden HTTP/1.1", host: "fixture-host"\n')
                self.assertEqual(rows[0]['event'], expected)
                self.assertEqual(rows[0]['method'], 'PATCH')
                for hidden in ('private-fixture', 'fixture-hidden', 'fixture-host'):
                    self.assertNotIn(hidden, json.dumps(rows))

    def test_unknown_errors_are_metadata_not_raw_text(self):
        rows = self.parse(STAMP + '[error] fixture-private-payload\n')
        self.assertEqual(rows[0]['event'], 'unclassified_gateway_error')
        self.assertNotIn('fixture-private-payload', json.dumps(rows))

    def test_postgrest_reconnect_and_error_code(self):
        rows = self.parse(STAMP + 'Successfully connected to PostgreSQL fixture-host\n' + STAMP + '{"code":"PGRST003","message":"fixture-private-payload"}\n', 'rest')
        self.assertEqual(rows[0]['event'], 'db_connected')
        self.assertEqual(rows[1]['code'], 'PGRST003')
        self.assertNotIn('fixture-', json.dumps(rows))

    def test_database_does_not_publish_sql_or_error_values(self):
        value = STAMP + 'ERROR: fixture-private-payload\n' + STAMP + 'STATEMENT: SELECT fixture-private-payload;\n'
        rows = self.parse(value, 'db')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['counts']['other_db_errors_omitted'], 1)
        self.assertNotIn('fixture-', json.dumps(rows))

    def test_database_transport_metadata_survives(self):
        rows = self.parse(STAMP + 'FATAL: terminating connection due to administrator command\n', 'db')
        self.assertEqual(rows[0]['event'], 'connection_terminated')

    def test_oversized_record_is_omitted_whole_not_as_fake_lines(self):
        rows = self.parse(STAMP + 'x' * 50000 + 'fixture-private-payload\n' + STAMP + '[error] upstream timed out\n')
        self.assertEqual(rows[0]['event'], 'upstream_timeout')
        self.assertEqual(rows[-1]['counts']['oversized_lines_omitted'], 1)
        self.assertEqual(rows[-1]['counts']['lines'], 2)
        self.assertNotIn('fixture-', json.dumps(rows))

    def test_untimestamped_or_control_text_never_echoed(self):
        rows = self.parse('fixture-private-payload\x1b[31m\n')
        self.assertEqual(rows[-1]['counts']['untimestamped_lines_omitted'], 1)
        self.assertIsNone(rows[-1]['firstTimestamp'])
        self.assertNotIn('fixture-', json.dumps(rows))

    def run_harness(self):
        # Fake executables only. Even if the behavior regresses, no Docker or
        # database is available through this test's command path.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts/lib').mkdir(parents=True)
            for name in ('derive-isolated-supabase-env.sh', 'assert-isolated-supabase-url.sh',
                         'integration-log-summary.py'):
                shutil.copy(ROOT / 'lib' / name, root / 'scripts/lib' / name)
            source = Path(os.environ.get('INTEGRATION_HARNESS_UNDER_TEST', ROOT / 'test-integration-db-local.sh'))
            harness = root / 'scripts/test-integration-db-local.sh'
            shutil.copy(source, harness)
            fake = root / 'bin'
            fake.mkdir()
            shim = fake / 'shim'
            shim.write_text('#!' + sys.executable + '\n' + r'''import json, os, pathlib, sys
from datetime import datetime, timezone
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if name == 'supabase':
    print('API_URL="http://127.0.0.1:55421"')
    print('SERVICE_ROLE_KEY="fixture-service-role-key"')
    print('JWT_SECRET="fixture-jwt-secret"')
elif name == 'curl':
    print('200')
elif name == 'yarn':
    pathlib.Path(os.environ['FIXTURE_SUITE_STAMP']).write_text(datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
    print('fixture-suite-failed')
    sys.exit(7)
elif name == 'docker':
    with open(os.environ['FIXTURE_DOCKER_TRACE'], 'a') as trace:
        trace.write(json.dumps(args) + '\n')
    if args[0] == 'ps':
        for service in ('db', 'rest', 'kong'):
            print('supabase_' + service + '_' + os.environ['INTEGRATION_SUPABASE_PROJECT_ID'])
    elif args[0] == 'inspect':
        print(args[-1] if '{{.Id}}' in args else 'status=running restarts=0 oomKilled=false')
    elif args[0] == 'logs':
        stamp = pathlib.Path(os.environ['FIXTURE_SUITE_STAMP']).read_text() + ' '
        bad = stamp + 'client "POST /rest/v1/rpc/probe?token=fixture-hidden HTTP/1.1" 502 20 "-" "node"'
        good = stamp + 'client "GET /rest/v1/probe?token=fixture-hidden HTTP/1.1" 200 2 "-" "node"'
        if '_rest_' in args[-1]:
            lines = [os.environ['FIXTURE_OLD_STAMP'] + ' PGRST003 fixture-hidden',
                     os.environ['FIXTURE_PRELUDE_STAMP'] + ' Received a schema cache reload message fixture-hidden',
                     stamp + 'Schema cache loaded in 1 milliseconds fixture-hidden']
        elif '_db_' in args[-1]:
            lines = [stamp + 'LOG: database system is ready to accept connections']
        else:
            lines = [bad] + [good] * 200
        if '--since' in args:
            since = datetime.fromisoformat(args[args.index('--since') + 1].replace('Z', '+00:00'))
            lines = [line for line in lines if datetime.fromisoformat(line.split(' ', 1)[0].replace('Z', '+00:00')) >= since]
        if '--tail' in args:
            lines = lines[-int(args[args.index('--tail') + 1]):]
        print('\n'.join(lines))
''')
            shim.chmod(0o755)
            for name in ('supabase', 'curl', 'yarn', 'docker', 'sleep'):
                (fake / name).symlink_to(shim)
            env = dict(PATH=str(fake) + ':/usr/bin:/bin', HOME=directory,
                       INTEGRATION_MANAGED_WORKDIR=directory,
                       INTEGRATION_MANAGED_API_PORT='55421', INTEGRATION_MANAGED_DB_PORT='55422',
                       INTEGRATION_SUPABASE_PROJECT_ID='ink-integration-summary-test',
                       FIXTURE_DOCKER_TRACE=str(root / 'docker-trace.jsonl'),
                       FIXTURE_SUITE_STAMP=str(root / 'suite-stamp'),
                       FIXTURE_OLD_STAMP=(datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat().replace('+00:00', 'Z'),
                       FIXTURE_PRELUDE_STAMP=(datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat().replace('+00:00', 'Z'))
            run = subprocess.run(['bash', '-c', 'source "$1"', '_', str(harness)],
                                 env=env, capture_output=True, text=True, timeout=15)
            trace = [json.loads(line) for line in (root / 'docker-trace.jsonl').read_text().splitlines()]
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('fixture-suite-failed', run.stdout)
            return run, trace

    def assert_all_logs_collected(self, trace):
        # A/B controls must actually reach the old loop and the new collector.
        # Missing docker ps used to let the old control fail vacuously here.
        logs = [args for args in trace if args[0] == 'logs']
        self.assertEqual([args[-1] for args in logs], [
            'supabase_' + service + '_ink-integration-summary-test'
            for service in ('db', 'rest', 'kong')
        ])
        return logs

    def test_real_harness_failure_keeps_early_event_without_raw_log_values(self):
        run, trace = self.run_harness()
        self.assert_all_logs_collected(trace)
        # Assert the contract, not just exit status: old tail also exits 1.
        # Accept the original raw access record OR the sanitized metadata:
        # otherwise a formatting change alone would make the old control red.
        self.assertRegex(run.stdout, r'(?:"status": 502|HTTP/1\.1" 502 )')

    def test_real_harness_failure_never_dumps_raw_log_values(self):
        run, trace = self.run_harness()
        self.assert_all_logs_collected(trace)
        self.assertNotIn('fixture-hidden', run.stdout + run.stderr)

    def test_real_harness_keeps_pre_invocation_schema_reload(self):
        run, trace = self.run_harness()
        self.assert_all_logs_collected(trace)
        self.assertIn('"event": "schema_reload_requested"', run.stdout)

    def test_real_harness_excludes_history_older_than_prelude(self):
        run, trace = self.run_harness()
        self.assert_all_logs_collected(trace)
        self.assertNotIn('PGRST003', run.stdout)

    def test_wiring_captures_window_not_tail_and_keeps_failure(self):
        harness = (ROOT / 'test-integration-db-local.sh').read_text()
        self.assertIn('DIAGNOSTICS_SINCE=', harness)
        self.assertIn('"${service}" "${id}" "${DIAGNOSTICS_SINCE}"', harness)
        self.assertNotIn('docker logs --tail', harness)
        self.assertIn('integration-log-summary.py', harness)
        self.assertIn('dump_stack_diagnostics\n  exit 1', harness)

    def test_capture_bounds_hung_child_and_preserves_early_event(self):
        # Replace Docker with a harmless child which emits synthetic text and
        # sleeps. No daemon or application container is reachable here.
        real_popen = subprocess.Popen
        code = ('import time; print(' + repr(STAMP + '[error] upstream timed out') +
                ', flush=True); time.sleep(10)')
        with mock.patch.object(summary.subprocess, 'Popen', side_effect=lambda *a, **kw:
                               real_popen([sys.executable, '-c', code], **kw)) as popen:
            rows = []
            result = summary.capture('kong', 'fixture-container', 'fixture-since', rows.append, timeout=1)
        self.assertEqual(result, 1)
        self.assertEqual(rows[0]['event'], 'upstream_timeout')
        self.assertEqual(rows[-1]['reason'], 'timeout')
        self.assertEqual(popen.call_args.args[0],
                         ['docker', 'logs', '--since', 'fixture-since', '--timestamps', 'fixture-container'])

    def test_capture_reports_nonzero_without_echoing_docker_error(self):
        real_popen = subprocess.Popen
        with mock.patch.object(summary.subprocess, 'Popen', side_effect=lambda *a, **kw:
                               real_popen([sys.executable, '-c',
                                           'import sys; print("fixture-private-error"); sys.exit(3)'], **kw)):
            rows = []
            self.assertEqual(summary.capture('rest', 'fixture-container', 'fixture-since', rows.append), 1)
        self.assertEqual(rows[-1]['reason'], 'command_failed')
        self.assertNotIn('fixture-private-error', json.dumps(rows))

    def test_capture_reports_missing_executable_without_echoing_error(self):
        with mock.patch.object(summary.subprocess, 'Popen', side_effect=OSError('fixture-private-error')):
            rows = []
            self.assertEqual(summary.capture('db', 'fixture-container', 'fixture-since', rows.append), 1)
        self.assertEqual(rows, [{'service': 'db', 'event': 'capture_incomplete', 'reason': 'start_failed'}])


if __name__ == '__main__':
    unittest.main()
