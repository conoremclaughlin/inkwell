#!/usr/bin/env python3
"""Allowlisted metadata from disposable-stack logs; never echo source text.

A line-tail hid the failing request behind later successful traffic. Read the
whole invocation window instead, without publishing URLs/query credentials,
SQL, row values, response bodies, headers, or arbitrary exception messages.
"""
import collections
import json
import re
import subprocess
import sys
import threading

TIMESTAMP = re.compile(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ')
ACCESS = re.compile(r'"(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) [^"\r\n]* HTTP/[0-9.]+" ([1-5][0-9]{2}) ')
TRANSPORT = {
    'upstream prematurely closed connection': 'upstream_closed',
    'Connection reset by peer': 'upstream_reset',
    'upstream timed out': 'upstream_timeout',
    'upstream sent too big header': 'upstream_header_too_large',
    'connect() failed': 'upstream_connect_failed',
    'no live upstreams': 'no_live_upstreams',
}
REST_EVENTS = {
    'Received a schema cache reload message': 'schema_reload_requested',
    'Schema cache loaded in ': 'schema_loaded',
    'Successfully connected to PostgreSQL': 'db_connected',
    'Connection Pool initialized': 'pool_initialized',
    'Config reloaded': 'config_reloaded',
}
DB_EVENTS = {
    # This is the DB's client connection, not Kong's upstream connection.
    'Connection reset by peer': 'client_connection_reset',
    'too many clients already': 'too_many_clients',
    'remaining connection slots are reserved': 'connection_slots_reserved',
    'deadlock detected': 'deadlock',
    'terminating connection due to administrator command': 'connection_terminated',
    'database system is ready to accept connections': 'db_ready',
    'database system is shut down': 'db_shutdown',
    'canceling statement due to statement timeout': 'statement_timeout',
}
MAX_LINE = 16384


def summarize(stream, service, emit):
    counts = collections.Counter()
    first = last = None
    while True:
        line = stream.readline(MAX_LINE + 1)
        if not line:
            break
        counts['lines'] += 1
        if len(line) > MAX_LINE:
            # Drop the entire record, not just its head: a chunk inside SQL is
            # not a new log record. The omission is explicit in the summary.
            while line and not line.endswith('\n'):
                line = stream.readline(MAX_LINE + 1)
            counts['oversized_lines_omitted'] += 1
            continue
        stamp = TIMESTAMP.match(line)
        if not stamp:
            counts['untimestamped_lines_omitted'] += 1
            continue
        when = stamp.group(1)
        first = first or when
        last = when
        event = {'service': service, 'timestamp': when}
        if service == 'kong':
            access = ACCESS.search(line)
            if access:
                method, status = access.groups()
                counts['http_' + status] += 1
                if int(status) >= 500:
                    emit(dict(event, event='http_failure', method=method, status=int(status)))
            if '[error]' in line or '[crit]' in line or '[alert]' in line:
                kind = next((value for key, value in TRANSPORT.items() if key in line), 'unclassified_gateway_error')
                method = re.search(r'request: "(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) ', line)
                counts[kind] += 1
                emit(dict(event, event=kind, **({'method': method.group(1)} if method else {})))
        elif service == 'rest':
            kind = next((value for key, value in REST_EVENTS.items() if key in line), None)
            code = re.search(r'\bPGRST[0-9]{3}\b', line)
            if kind or code:
                emit(dict(event, event=kind or 'postgrest_error', **({'code': code.group(0)} if code else {})))
            else:
                counts['other_rest_lines_omitted'] += 1
        else:
            kind = next((value for key, value in DB_EVENTS.items() if key in line), None)
            if kind:
                emit(dict(event, event=kind))
            elif re.search(r'\b(?:ERROR|FATAL|PANIC):', line):
                counts['other_db_errors_omitted'] += 1
            else:
                counts['other_db_lines_omitted'] += 1
    emit({'service': service, 'event': 'summary', 'firstTimestamp': first,
          'lastTimestamp': last, 'counts': dict(sorted(counts.items()))})


def capture(service, container, since, emit, timeout=20):
    """Bound Docker capture as well as record size, without printing its errors."""
    try:
        proc = subprocess.Popen(
            ['docker', 'logs', '--since', since, '--timestamps', container],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace',
        )
    except OSError:
        emit({'service': service, 'event': 'capture_incomplete', 'reason': 'start_failed'})
        return 1
    expired = threading.Event()

    def expire():
        expired.set()
        try:
            proc.kill()  # Only the docker-logs child we just created.
        except ProcessLookupError:
            pass

    timer = threading.Timer(timeout, expire)
    timer.start()
    try:
        with proc.stdout:
            summarize(proc.stdout, service, emit)
        status = proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
        proc.wait()
    if expired.is_set() or status != 0:
        emit({'service': service, 'event': 'capture_incomplete',
              'reason': 'timeout' if expired.is_set() else 'command_failed'})
        return 1
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in {'kong', 'rest', 'db'}:
        sys.exit('expected: service container-id since-timestamp')
    sys.exit(capture(*sys.argv[1:], lambda row: print(json.dumps(row), flush=True)))
