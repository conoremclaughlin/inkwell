#!/bin/sh
# Regression coverage for scripts/lib/disable-kong-upstream-keepalive.sh, the
# harness step that stops the isolated stack's Kong pooling connections to
# PostgREST (task 388ae17e).
#
# What is pinned:
#   - the reload carries the setting AND the CLI's nginx template, exactly:
#     without the template Kong regenerates nginx.conf from its default one
#   - success is judged by reading the setting back, not by reload's exit code
#   - a warm stack that already holds the setting is not reloaded again
#   - every path that cannot confirm the setting returns 1
#   - only an integration stack's Kong is ever touched: the shared stack's
#     container is refused before docker is called at all
#   - Kong's own output never reaches ours: a reload error can quote the
#     declarative config, and that carries the stack's keys
#   - the harness sources the library and calls it for its own project
#
# Mock-only: `docker` is a stub on PATH that records its argv and answers from
# a state directory. No container, no Kong. Every fixture is synthetic.
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
cat >"$work/bin/docker" <<'STUB'
#!/bin/sh
state="$FAKE_DOCKER_STATE"
for a in "$@"; do printf '%s|' "$a"; done >>"$state/calls"
echo >>"$state/calls"
case "$1 $2" in
  "exec -e")
    echo "znkongstdout"
    echo "znkongstderr" >&2
    rc=$(cat "$state/reload_rc")
    [ "$rc" = 0 ] && cp "$state/pool_after_reload" "$state/pool"
    exit "$rc"
    ;;
esac
case "$3" in
  sed)
    [ -f "$state/env_unreadable" ] && exit 1
    cat "$state/pool"
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
# $out (stdout+stderr), $rc, and $calls (the recorded argv lines).
run() { # container pool reload_rc pool_after_reload [template_present] [env_unreadable]
  state="$work/state"
  rm -rf "$state"
  mkdir -p "$state"
  : >"$state/calls"
  printf '%s\n' "$2" >"$state/pool"
  printf '%s\n' "$3" >"$state/reload_rc"
  printf '%s\n' "$4" >"$state/pool_after_reload"
  [ "${5:-yes}" = yes ] && : >"$state/template_present"
  [ "${6:-no}" = yes ] && : >"$state/env_unreadable"
  out=$(env -i PATH="$work/bin:$PATH" HOME="${HOME:-/tmp}" FAKE_DOCKER_STATE="$state" \
    bash -c 'source "$1"; disable_kong_upstream_keepalive "$2"' _ "$lib" "$1" 2>&1)
  rc=$?
  calls=$(cat "$state/calls")
}
reloads() { printf '%s\n' "$calls" | grep -c '|reload|'; }
no_kong_output() { ! printf '%s' "$out" | grep -q 'znkong'; }

echo "RELOAD (pool size 60, the Kong 2.8.1 default)"

run "$KONG" 60 0 0
[ "$rc" -eq 0 ] && ok "returns 0 once the setting reads back 0" || bad "returns 0 once the setting reads back 0" "rc=$rc: $out"
printf '%s\n' "$calls" | grep -qxF "$RELOAD_ARGV" &&
  ok "reloads with the setting and the CLI's nginx template, exact argv" ||
  bad "reloads with the setting and the CLI's nginx template, exact argv" "calls: $(printf '%s' "$calls" | tr '\n' ' ')"
[ "$(reloads)" -eq 1 ] && ok "reloads exactly once" || bad "reloads exactly once" "$(reloads) reloads"
printf '%s' "$out" | grep -q 'pool size 60 -> 0' && ok "reports the change it made" || bad "reports the change it made" "$out"
no_kong_output && ok "prints none of Kong's own output on success" || bad "prints none of Kong's own output on success" "$out"

echo ""
echo "WARM STACK (already 0)"

run "$KONG" 0 0 0
[ "$rc" -eq 0 ] && ok "returns 0" || bad "returns 0" "rc=$rc: $out"
[ "$(reloads)" -eq 0 ] && ok "does not reload a gateway that already holds the setting" || bad "does not reload a gateway that already holds the setting" "$(reloads) reloads"

echo ""
echo "FAILURES (each must return 1)"

run "$KONG" 60 1 60
[ "$rc" -eq 1 ] && ok "a failed reload returns 1" || bad "a failed reload returns 1" "rc=$rc"
no_kong_output && ok "prints none of Kong's own output on a failed reload" || bad "prints none of Kong's own output on a failed reload" "$out"

# reload exits 0 but the setting did not take: success is the read-back.
run "$KONG" 60 0 60
[ "$rc" -eq 1 ] && ok "a reload that exits 0 without the setting taking returns 1" ||
  bad "a reload that exits 0 without the setting taking returns 1" "rc=$rc: $out"

run "$KONG" 60 0 0 no
[ "$rc" -eq 1 ] && ok "a missing nginx template returns 1" || bad "a missing nginx template returns 1" "rc=$rc"
[ "$(reloads)" -eq 0 ] && ok "a missing nginx template is never reloaded without" || bad "a missing nginx template is never reloaded without" "$(reloads) reloads"

run "$KONG" 60 0 0 yes yes
[ "$rc" -eq 1 ] && ok "an unreadable .kong_env returns 1" || bad "an unreadable .kong_env returns 1" "rc=$rc"
[ "$(reloads)" -eq 0 ] && ok "an unreadable .kong_env is not reloaded blind" || bad "an unreadable .kong_env is not reloaded blind" "$(reloads) reloads"

run "$KONG" "" 0 0
[ "$rc" -eq 1 ] && ok "an absent setting line returns 1" || bad "an absent setting line returns 1" "rc=$rc"

echo ""
echo "SCOPE (only an integration stack's Kong)"

# Controls first: the names the harness actually produces are accepted.
for name in supabase_kong_ink-integration supabase_kong_ink-integration-wren671 supabase_kong_pcp-integration; do
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
