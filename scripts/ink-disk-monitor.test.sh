#!/bin/sh
# Regression coverage for ink-disk-monitor.sh's check-in, against real HTTP
# responders on loopback.
#
# Why a real server rather than a stubbed curl: the defect was that curl exits
# 0 for 4xx and 5xx, so a stub returning "curl succeeded" would reproduce the
# bug's assumption rather than the bug. The only way to pin this is to let curl
# actually talk to something that answers 401.
#
# The monitor reports on the pipeline it reports THROUGH, so the failure it
# must never miss is its own endpoint being broken. Before this was fixed, an
# expired INK_ALERT_TOKEN made check_in succeed: the caller took note_reachable,
# the liveness sweep saw a fresh last_seen_at, and the monitor called itself
# healthy for as long as the endpoint stayed rejected.
#
# Usage:  sh scripts/ink-disk-monitor.test.sh

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
monitor="$root/scripts/ink-disk-monitor.sh"

if [ ! -r "$monitor" ]; then
  echo "cannot read $monitor" >&2
  exit 1
fi

responder_pid=''
work=$(mktemp -d "${TMPDIR:-/tmp}/disk-monitor-test.XXXXXX") || exit 1
cleanup() {
  [ -n "$responder_pid" ] && kill "$responder_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "  ok   $1"
}
bad() {
  fail=$((fail + 1))
  echo "  FAIL $1"
  [ $# -gt 1 ] && echo "         $2"
}

# python3 is the one HTTP server present everywhere this repo runs. Skip rather
# than lie if it is missing.
if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 unavailable, cannot stand up a loopback responder"
  exit 0
fi

port=''

# Launches a responder answering every POST with $1. Sets $port and
# $responder_pid in THIS shell — deliberately not called through $(...), because
# a background child inherits the substitution's pipe and command substitution
# waits for that pipe to close, not merely for the function to return.
start_responder() { # status_code
  port_file="$work/port.$1"
  rm -f "$port_file"
  # stdout/stderr detached for the same reason.
  python3 - "$1" "$port_file" >/dev/null 2>&1 <<'PY' &
import sys, http.server, socketserver

status = int(sys.argv[1])
port_file = sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        self.rfile.read(length)
        self.send_response(status)
        self.send_header('content-length', '0')
        self.end_headers()
    def log_message(self, *a):
        pass

with socketserver.TCPServer(('127.0.0.1', 0), H) as srv:
    with open(port_file, 'w') as f:
        f.write(str(srv.server_address[1]))
    srv.serve_forever()
PY
  responder_pid=$!
  i=0
  while [ "$i" -lt 100 ] && [ ! -s "$port_file" ]; do
    i=$((i + 1))
    sleep 0.05
  done
  [ -s "$port_file" ] || return 1
  port=$(cat "$port_file")
  return 0
}

stop_responder() {
  [ -n "$responder_pid" ] && kill "$responder_pid" 2>/dev/null
  responder_pid=''
}

# Runs the monitor's real check_in body against $1. The function is extracted
# from the script rather than copied here, so this cannot drift into testing a
# reimplementation of the thing it is meant to pin.
call_check_in() { # url -> exit status of check_in
  (
    INK_ALERT_URL="$1"
    INK_ALERT_TOKEN='synthetic-token-not-a-credential'
    SOURCE='test-source'
    INK_MONITOR_INTERVAL=300
    export INK_ALERT_URL INK_ALERT_TOKEN SOURCE INK_MONITOR_INTERVAL
    log() { :; }
    eval "$(awk '/^check_in\(\) \{/,/^\}/' "$monitor")"
    check_in 'free=1GB'
  )
}

echo "CHECK-IN (scripts/ink-disk-monitor.sh)"

if start_responder 401; then
  call_check_in "http://127.0.0.1:$port"
  rc=$?
  [ "$rc" -ne 0 ] && ok "a 401 check-in is a failure, not a healthy report" ||
    bad "a 401 check-in is a failure, not a healthy report" "check_in exited 0"
  stop_responder
else
  bad "loopback responder starts (401)" "no port published"
  stop_responder
fi

if start_responder 500; then
  call_check_in "http://127.0.0.1:$port"
  rc=$?
  [ "$rc" -ne 0 ] && ok "a 500 check-in is a failure" ||
    bad "a 500 check-in is a failure" "check_in exited 0"
  stop_responder
else
  bad "loopback responder starts (500)" "no port published"
  stop_responder
fi

# The control. Without it, "check_in returns nonzero" would also pass for a
# function that can never succeed — a differently broken monitor.
if start_responder 200; then
  call_check_in "http://127.0.0.1:$port"
  rc=$?
  [ "$rc" -eq 0 ] && ok "a 200 check-in still succeeds (control)" ||
    bad "a 200 check-in still succeeds (control)" "check_in exited $rc"
  stop_responder
else
  bad "loopback responder starts (200)" "no port published"
  stop_responder
fi

# A refused connection was already caught by curl's own exit status; pinned so
# the new status parsing cannot regress it into a success.
call_check_in "http://127.0.0.1:1"
rc=$?
[ "$rc" -ne 0 ] && ok "an unreachable endpoint is a failure" ||
  bad "an unreachable endpoint is a failure" "check_in exited 0"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
