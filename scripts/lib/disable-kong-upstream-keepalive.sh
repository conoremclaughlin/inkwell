#!/usr/bin/env bash
# Turn off Kong's upstream keepalive in the isolated stack's gateway.
#
# The "An invalid response was received from the upstream server" failures in
# the Integration DB job are Kong reusing a pooled connection to PostgREST at
# the moment PostgREST closes it. Kong 2.8.1 keeps idle upstream connections
# for up to 60 s (upstream_keepalive_idle_timeout); PostgREST closed idle
# connections after 32-60 s in the samples taken on v14.7 and v13.0.5
# (2026-09-27), so a pooled connection can be closed under Kong's feet. nginx
# retries an idempotent request on a fresh connection, and a GET never
# surfaces, but it will not resend a POST or PATCH, so those come back 502.
# Every one of the 13 captured 502s from 2026-09-22 to 2026-09-27 was a POST or
# a PATCH; the one run that also logged a GET hitting a closed connection
# (ca7213d5) did not fail on it. This is the leading explanation, not a
# reproduced one: Lumen's synthetic probe of 1,200 POSTs across 31-51 s idle
# gaps (2026-09-22) never hit the race. Evidence and population: Inkwell task
# 388ae17e.
#
# With pool size 0 Kong opens a fresh upstream connection per request, so no
# pooled connection exists to be closed. A lower idle timeout would also work,
# but only while PostgREST's idle close stays above it, and the sampled minimum
# is not a guaranteed bound; pool size 0 does not depend on the upstream's
# timing. (Not idle timeout 0: Kong 2.8.1's kong.conf.default documents that
# as keeping an idle connection open indefinitely.) The cost is one TCP
# connect per request inside the stack's network, and one TIME_WAIT socket per
# request on Kong's side: a full pass is ~4,900 requests in ~30 s, well inside
# the ephemeral range's ~470/s ceiling at a 60 s TIME_WAIT.
#
# The Supabase CLI sets Kong's environment and exposes no keepalive setting,
# and PostgREST has no server timeout option, so this reconfigures the running
# container: `kong reload` with the setting in the environment, and the CLI's
# own nginx template, since a reload without it regenerates nginx.conf from
# Kong's default template. The reload is graceful. It starts from the running
# node's own .kong_env, so the setting holds across later reloads, but not
# across `supabase start`, which recreates the container; on a warm stack where
# it already holds, nothing is reloaded.
#
#   disable_kong_upstream_keepalive "supabase_kong_${PROJECT_ID}"   # exit 0 or 1
#
# Returns 1, with a reason, when it could not confirm the setting; the caller
# decides whether that stops the run. Kong's own output is never printed: a
# reload error can quote the declarative config, which carries the stack's keys.

KONG_NGINX_TEMPLATE="${KONG_NGINX_TEMPLATE:-/home/kong/custom_nginx.template}"
# Every docker call is bounded, so a wedged daemon or reload cannot hold the
# job. The settle bound is how long the running worker may take to report the
# new setting after `kong reload` returns.
KONG_ADMIN_READ_TIMEOUT_SECONDS="${KONG_ADMIN_READ_TIMEOUT_SECONDS:-10}"
KONG_RELOAD_TIMEOUT_SECONDS="${KONG_RELOAD_TIMEOUT_SECONDS:-60}"
KONG_SETTLE_TIMEOUT_SECONDS="${KONG_SETTLE_TIMEOUT_SECONDS:-15}"

# Run a command with a wall-clock bound: exit 124 when it runs out, and the
# command is killed. Python because the harness already requires it and
# coreutils `timeout` is absent on macOS. Not perl's alarm: docker is a Go
# binary, and Go ignores SIGALRM (measured: an alarmed `docker exec ... sleep 8`
# ran all 8 s). Killing the docker client ends our wait; it does not stop a
# process already started inside the container.
kong_run_bounded() {
  python3 -c 'import subprocess, sys
try:
    sys.exit(subprocess.call(sys.argv[2:], timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    sys.exit(124)' "$@"
}

# The pool size Kong's running worker uses, from its admin API, which listens
# on loopback inside the container. Not .kong_env: `kong reload` writes that
# file before it signals nginx, and `kong prepare` rewrites it with no reload
# at all. Measured 2026-09-27: after a prepare to 0, .kong_env read 0 while the
# admin API read 60 and Kong still held a connection to rest:3000 after five
# requests; the admin API matched the held connections in every state. Only
# the one field leaves the container. Prints nothing when it cannot read it.
kong_upstream_keepalive_pool_size() {
  kong_run_bounded "$KONG_ADMIN_READ_TIMEOUT_SECONDS" docker exec "$1" sh -c \
    'wget -q -T 5 -O - http://127.0.0.1:8001/ 2>/dev/null | grep -o "\"upstream_keepalive_pool_size\":[0-9]*" | cut -d: -f2' \
    2>/dev/null
}

disable_kong_upstream_keepalive() {
  local container="$1"
  local before after deadline
  local rc=0
  # Only ever the disposable integration stack's gateway. The harness's parent
  # already refuses any other project ID; this is the one step that
  # reconfigures a running container, and the shared stack's Kong is a single
  # name away, so it checks again rather than trusting its caller. Only the
  # current project prefix: the harness runs a pre-rename project for --stop
  # alone, which never reaches this step.
  if [[ ! "$container" =~ ^supabase_kong_ink-integration(-[a-zA-Z0-9_-]+)?$ ]]; then
    echo "[integration-db] Not reconfiguring ${container}: not an integration stack's Kong." >&2
    return 1
  fi
  before="$(kong_upstream_keepalive_pool_size "$container")"
  if [[ -z "$before" ]]; then
    echo "[integration-db] Could not read Kong's upstream keepalive setting from ${container}'s admin API." >&2
    return 1
  fi
  if [[ "$before" == "0" ]]; then
    echo "[integration-db] Kong upstream keepalive already off (pool size 0)."
    return 0
  fi
  if ! kong_run_bounded "$KONG_ADMIN_READ_TIMEOUT_SECONDS" docker exec "$container" \
    test -r "$KONG_NGINX_TEMPLATE" 2>/dev/null; then
    echo "[integration-db] Kong's nginx template ${KONG_NGINX_TEMPLATE} is missing; not reloading." >&2
    return 1
  fi
  kong_run_bounded "$KONG_RELOAD_TIMEOUT_SECONDS" docker exec -e KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0 "$container" \
    kong reload --nginx-conf "$KONG_NGINX_TEMPLATE" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 124 ]]; then
    echo "[integration-db] kong reload did not finish within ${KONG_RELOAD_TIMEOUT_SECONDS}s; upstream keepalive may still be on (pool size ${before})." >&2
    return 1
  elif [[ "$rc" -ne 0 ]]; then
    echo "[integration-db] kong reload failed; upstream keepalive is still on (pool size ${before})." >&2
    return 1
  fi
  # `kong reload` returns once nginx has been signalled. The worker answering
  # the admin API went on reporting the old value for up to a second after
  # that (measured twice, 2026-09-27), so wait for it, to a deadline.
  deadline=$((SECONDS + KONG_SETTLE_TIMEOUT_SECONDS))
  while :; do
    after="$(kong_upstream_keepalive_pool_size "$container")"
    [[ "$after" == "0" ]] && break
    if ((SECONDS >= deadline)); then
      echo "[integration-db] Kong reloaded, but its worker still reports upstream keepalive pool size '${after}' after ${KONG_SETTLE_TIMEOUT_SECONDS}s, not 0." >&2
      return 1
    fi
    sleep 0.5
  done
  echo "[integration-db] Kong upstream keepalive off (pool size ${before} -> 0)."
  return 0
}
