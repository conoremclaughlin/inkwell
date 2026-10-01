#!/bin/sh
# Regression coverage for scripts/lib/disable-kong-upstream-keepalive.sh, the
# harness step that stops the isolated stack's Kong pooling connections to
# PostgREST (task 388ae17e).
#
# What is pinned:
#   - the reload carries the setting AND the CLI's nginx template, exactly:
#     without the template Kong regenerates nginx.conf from its default one
#   - the setting is read from the running worker (Kong's admin API), never
#     from .kong_env, which the reload writes before nginx takes it; only the
#     one field leaves the container
#   - success is the worker reporting 0, waited for to a deadline, not reload's
#     exit code and not one read taken straight after it
#   - a warm stack whose worker already holds the setting is not reloaded, and
#     one whose .kong_env says 0 while the worker still pools is
#   - every docker call is bounded: a hung reload or read returns 1 in time
#   - every path that cannot confirm the setting returns 1
#   - only an integration stack's Kong is ever touched: the shared stack's
#     container is refused before docker is called at all
#   - Kong's own output never reaches ours: a reload error can quote the
#     declarative config, and that carries the stack's keys
#   - the harness sources the library and calls it for its own project
#
# Mock-only: `docker` is a stub on PATH that records its argv and answers from
# a state directory. No container, no Kong. Every fixture is synthetic. The
# stub models what was measured on a real Kong 2.8.1 on 2026-09-27: the prefix
# (.kong_env) and the running worker can disagree, and the worker picks up a
# reload a moment after `kong reload` returns.
#
# Usage:  sh scripts/test-disable-kong-upstream-keepalive.test.sh
#
# KONG_KEEPALIVE_LIB_UNDER_TEST and INTEGRATION_HARNESS_UNDER_TEST point the
# suite at substitutes, so a deliberately regressed library can be checked for
# turning it red rather than assumed to.

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
lib="${KONG_KEEPALIVE_LIB_UNDER_TEST:-$root/scripts/lib/disable-kong-upstream-keepalive.sh}"
harness="${INTEGRATION_HARNESS_UNDER_TEST:-$root/scripts/test-integration-db-local.sh}"
for f in "$lib" "$harness"; do
  [ -r "$f" ] || {
    echo "missing file under test: $f" >&2
    exit 1
  }
done

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

work=$(mktemp -d "${TMPDIR:-/tmp}/kong-keepalive-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The stub. Arguments are recorded one per field, '|'-terminated, so a test can
# compare the exact argv rather than a space-joined approximation of it.
#   exec -e ... kong reload   rewrites the prefix at once; the worker adopts
#                             the value after `lag` further admin reads
#   exec <c> sh -c <script>   the admin API read: the worker's value
#   exec <c> sed ...          a .kong_env read: the prefix's value
#   exec <c> test -r <file>   the template check
# A *_sleep file makes that call hang; `exec` so the bound kills the sleeper
# itself rather than leaving it holding our output pipe.
cat >"$work/bin/docker" <<'STUB'
#!/bin/sh
state="$FAKE_DOCKER_STATE"
for a in "$@"; do printf '%s|' "$a"; done >>"$state/calls"
echo >>"$state/calls"
case "$1 $2" in
  "exec -e")
    echo "znkongstdout"
    echo "znkongstderr" >&2
    [ -f "$state/reload_sleep" ] && exec sleep "$(cat "$state/reload_sleep")"
    rc=$(cat "$state/reload_rc")
    if [ "$rc" = 0 ]; then
      cp "$state/pool_after_reload" "$state/file_pool"
      cp "$state/pool_after_reload" "$state/pending"
      cp "$state/lag_after_reload" "$state/lag"
    fi
    exit "$rc"
    ;;
esac
case "$3" in
  sh)
    [ -f "$state/read_sleep" ] && exec sleep "$(cat "$state/read_sleep")"
    [ -f "$state/admin_unreadable" ] && exit 0
    if [ -f "$state/pending" ]; then
      lag=$(cat "$state/lag")
      if [ "$lag" -gt 0 ]; then
        echo $((lag - 1)) >"$state/lag"
      else
        mv "$state/pending" "$state/worker_pool"
      fi
    fi
    cat "$state/worker_pool"
    exit 0
    ;;
  sed)
    cat "$state/file_pool"
    exit 0
    ;;
  test)
    [ -f "$state/template_present" ] && exit 0
    exit 1
    ;;
esac
exit 99
STUB
chmod +x "$work/bin/docker"

KONG=supabase_kong_ink-integration
RELOAD_ARGV="exec|-e|KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0|$KONG|kong|reload|--nginx-conf|/home/kong/custom_nginx.template|"

# One scenario: fresh state, then run the function in a clean bash. Sets
# $out (stdout+stderr), $rc, $elapsed (whole seconds) and $calls (the recorded
# argv lines).
#   run <container> <worker pool> <reload rc> <pool after reload> [option...]
# Options: file=N (.kong_env differs from the worker), lag=N, template=no,
# unreadable, reload_sleep=S, read_sleep=S, settle=S, reload_timeout=S,
# read_timeout=S.
run() {
  state="$work/state"
  rm -rf "$state"
  mkdir -p "$state"
  : >"$state/calls"
  container="$1"
  printf '%s\n' "$2" >"$state/worker_pool"
  printf '%s\n' "$2" >"$state/file_pool"
  printf '%s\n' "$3" >"$state/reload_rc"
  printf '%s\n' "$4" >"$state/pool_after_reload"
  printf '0\n' >"$state/lag_after_reload"
  : >"$state/template_present"
  settle=5
  reload_timeout=5
  read_timeout=5
  shift 4
  for opt in "$@"; do
    case "$opt" in
      file=*) printf '%s\n' "${opt#file=}" >"$state/file_pool" ;;
      lag=*) printf '%s\n' "${opt#lag=}" >"$state/lag_after_reload" ;;
      template=no) rm -f "$state/template_present" ;;
      unreadable) : >"$state/admin_unreadable" ;;
      reload_sleep=*) printf '%s\n' "${opt#reload_sleep=}" >"$state/reload_sleep" ;;
      read_sleep=*) printf '%s\n' "${opt#read_sleep=}" >"$state/read_sleep" ;;
      settle=*) settle="${opt#settle=}" ;;
      reload_timeout=*) reload_timeout="${opt#reload_timeout=}" ;;
      read_timeout=*) read_timeout="${opt#read_timeout=}" ;;
      *)
        echo "unknown run option: $opt" >&2
        exit 2
        ;;
    esac
  done
  started=$(date +%s)
  out=$(env -i PATH="$work/bin:$PATH" HOME="${HOME:-/tmp}" FAKE_DOCKER_STATE="$state" \
    KONG_SETTLE_TIMEOUT_SECONDS="$settle" KONG_RELOAD_TIMEOUT_SECONDS="$reload_timeout" \
    KONG_ADMIN_READ_TIMEOUT_SECONDS="$read_timeout" \
    bash -c 'source "$1"; disable_kong_upstream_keepalive "$2"' _ "$lib" "$container" 2>&1)
  rc=$?
  elapsed=$(($(date +%s) - started))
  calls=$(cat "$state/calls")
}
reloads() { printf '%s\n' "$calls" | grep -c '|reload|'; }
reads_after_reload() {
  printf '%s\n' "$calls" | awk '/\|reload\|/ { seen = 1; next } seen && /\|sh\|-c\|/ { n++ } END { print n + 0 }'
}
no_kong_output() { ! printf '%s' "$out" | grep -q 'znkong'; }

echo "RELOAD (pool size 60, the Kong 2.8.1 default)"

run "$KONG" 60 0 0
[ "$rc" -eq 0 ] && ok "returns 0 once the worker reports 0" || bad "returns 0 once the worker reports 0" "rc=$rc: $out"
printf '%s\n' "$calls" | grep -qxF "$RELOAD_ARGV" &&
  ok "reloads with the setting and the CLI's nginx template, exact argv" ||
  bad "reloads with the setting and the CLI's nginx template, exact argv" "calls: $(printf '%s' "$calls" | tr '\n' ' ')"
[ "$(reloads)" -eq 1 ] && ok "reloads exactly once" || bad "reloads exactly once" "$(reloads) reloads"
printf '%s' "$out" | grep -q 'pool size 60 -> 0' && ok "reports the change it made" || bad "reports the change it made" "$out"
no_kong_output && ok "prints none of Kong's own output on success" || bad "prints none of Kong's own output on success" "$out"

echo ""
echo "READ (the running worker, not the prefix)"

printf '%s\n' "$calls" | grep -qF '|sh|-c|wget ' && printf '%s\n' "$calls" | grep -qF 'http://127.0.0.1:8001/' &&
  ok "reads the setting from Kong's admin API" ||
  bad "reads the setting from Kong's admin API" "calls: $(printf '%s' "$calls" | tr '\n' ' ')"
! printf '%s\n' "$calls" | grep -qF '.kong_env' &&
  ok "never reads .kong_env" || bad "never reads .kong_env" "calls: $(printf '%s' "$calls" | tr '\n' ' ')"
# The admin API's answer is the node's whole configuration; the field is cut
# out inside the container, so only a number crosses into our output.
printf '%s\n' "$calls" | grep -F '|sh|-c|' | grep -qF '| cut -d: -f2|' &&
  ok "extracts the one field inside the container" ||
  bad "extracts the one field inside the container" "calls: $(printf '%s' "$calls" | tr '\n' ' ')"

echo ""
echo "SETTLE (the worker lags the reload)"

run "$KONG" 60 0 0 lag=2
[ "$rc" -eq 0 ] && ok "waits for a worker that reports the old value after reload returns" ||
  bad "waits for a worker that reports the old value after reload returns" "rc=$rc: $out"
[ "$(reads_after_reload)" -eq 3 ] && ok "reads again until the worker reports 0, then stops" ||
  bad "reads again until the worker reports 0, then stops" "$(reads_after_reload) reads after the reload"

# reload exits 0 but the worker never takes the setting: success is the worker.
run "$KONG" 60 0 60 settle=1
[ "$rc" -eq 1 ] && ok "a reload that exits 0 without the worker taking the setting returns 1" ||
  bad "a reload that exits 0 without the worker taking the setting returns 1" "rc=$rc: $out"
printf '%s' "$out" | grep -q "still reports upstream keepalive pool size '60'" &&
  ok "says what the worker still reports" || bad "says what the worker still reports" "$out"
[ "$elapsed" -le 4 ] && ok "gives up at the settle deadline" || bad "gives up at the settle deadline" "took ${elapsed}s with a 1s deadline"

echo ""
echo "WARM STACK"

run "$KONG" 0 0 0
[ "$rc" -eq 0 ] && ok "returns 0 when the worker already reports 0" || bad "returns 0 when the worker already reports 0" "rc=$rc: $out"
[ "$(reloads)" -eq 0 ] && ok "does not reload a worker that already holds the setting" ||
  bad "does not reload a worker that already holds the setting" "$(reloads) reloads"

# The state measured with `kong prepare`: the prefix says 0, the worker pools.
run "$KONG" 60 0 0 file=0
[ "$rc" -eq 0 ] && [ "$(reloads)" -eq 1 ] &&
  ok "reloads when .kong_env says 0 but the worker still pools" ||
  bad "reloads when .kong_env says 0 but the worker still pools" "rc=$rc, $(reloads) reloads: $out"

echo ""
echo "BOUNDS (a hung docker call returns 1 in time)"

run "$KONG" 60 0 0 reload_sleep=8 reload_timeout=1
[ "$rc" -eq 1 ] && ok "a reload that hangs returns 1" || bad "a reload that hangs returns 1" "rc=$rc: $out"
[ "$elapsed" -le 4 ] && ok "a reload that hangs is abandoned at its bound" ||
  bad "a reload that hangs is abandoned at its bound" "took ${elapsed}s with a 1s bound"
printf '%s' "$out" | grep -q 'did not finish within 1s' && ok "says the reload timed out" || bad "says the reload timed out" "$out"
no_kong_output && ok "prints none of Kong's own output on a timed-out reload" ||
  bad "prints none of Kong's own output on a timed-out reload" "$out"

run "$KONG" 60 0 0 read_sleep=8 read_timeout=1
[ "$rc" -eq 1 ] && ok "a read that hangs returns 1" || bad "a read that hangs returns 1" "rc=$rc: $out"
[ "$elapsed" -le 4 ] && ok "a read that hangs is abandoned at its bound" ||
  bad "a read that hangs is abandoned at its bound" "took ${elapsed}s with a 1s bound"
[ "$(reloads)" -eq 0 ] && ok "a hung read is not followed by a blind reload" ||
  bad "a hung read is not followed by a blind reload" "$(reloads) reloads"

echo ""
echo "FAILURES (each must return 1)"

run "$KONG" 60 1 60
[ "$rc" -eq 1 ] && ok "a failed reload returns 1" || bad "a failed reload returns 1" "rc=$rc"
no_kong_output && ok "prints none of Kong's own output on a failed reload" || bad "prints none of Kong's own output on a failed reload" "$out"

run "$KONG" 60 0 0 template=no
[ "$rc" -eq 1 ] && ok "a missing nginx template returns 1" || bad "a missing nginx template returns 1" "rc=$rc"
[ "$(reloads)" -eq 0 ] && ok "a missing nginx template is never reloaded without" || bad "a missing nginx template is never reloaded without" "$(reloads) reloads"

run "$KONG" 60 0 0 unreadable
[ "$rc" -eq 1 ] && ok "an unreadable admin API returns 1" || bad "an unreadable admin API returns 1" "rc=$rc"
[ "$(reloads)" -eq 0 ] && ok "an unreadable admin API is not reloaded blind" || bad "an unreadable admin API is not reloaded blind" "$(reloads) reloads"

run "$KONG" "" 0 0
[ "$rc" -eq 1 ] && ok "an absent setting returns 1" || bad "an absent setting returns 1" "rc=$rc"

echo ""
echo "SCOPE (only an integration stack's Kong)"

# Controls first: the names the harness actually produces are accepted.
for name in supabase_kong_ink-integration supabase_kong_ink-integration-wren671; do
  run "$name" 0 0 0
  [ "$rc" -eq 0 ] && ok "accepts $name" || bad "accepts $name" "rc=$rc: $out"
done
for name in supabase_kong_personal-context-protocol supabase_kong_inktrade supabase_rest_ink-integration \
  "supabase_kong_ink-integration x" supabase_kong_ink-integrationx; do
  run "$name" 60 0 0
  [ "$rc" -eq 1 ] && [ -z "$calls" ] &&
    ok "refuses '$name' without calling docker" ||
    bad "refuses '$name' without calling docker" "rc=$rc calls=$(printf '%s' "$calls" | tr '\n' ' ')"
done

echo ""
echo "HARNESS WIRING (scripts/test-integration-db-local.sh)"

grep -q 'source "${ROOT_DIR}/scripts/lib/disable-kong-upstream-keepalive.sh"' "$harness" &&
  ok "the harness sources the library" || bad "the harness sources the library"
grep -qE 'disable_kong_upstream_keepalive "supabase_kong_\$\{PROJECT_ID\}"' "$harness" &&
  ok "the harness calls it for its own project's Kong" || bad "the harness calls it for its own project's Kong"
# Before the suite runs, not after it: the call must precede the vitest line.
call_line=$(grep -n 'disable_kong_upstream_keepalive "supabase_kong_' "$harness" | head -1 | cut -d: -f1)
suite_line=$(grep -n 'workspace @inklabs/api test:integration:db' "$harness" | head -1 | cut -d: -f1)
[ -n "$call_line" ] && [ -n "$suite_line" ] && [ "$call_line" -lt "$suite_line" ] &&
  ok "the harness reconfigures Kong before the suite starts" ||
  bad "the harness reconfigures Kong before the suite starts" "call line ${call_line:-none}, suite line ${suite_line:-none}"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
