#!/bin/sh
# Regression coverage for the integration-DB harness's endpoint isolation:
# scripts/lib/derive-isolated-supabase-env.sh and
# scripts/lib/assert-isolated-supabase-url.sh.
#
# What is pinned:
#   - an ambient SUPABASE_URL does not survive into the derived API endpoint
#   - ambient keys (secret, publishable, JWT) do not survive either
#   - an ambient DB_URL does not survive into INTEGRATION_DB_URL
#   - both endpoints land on the SAME stack — the split-target bug in which
#     PostgREST traffic addresses an inherited stack while direct PG addresses
#     the isolated one (#621/#623)
#   - a status output missing required fields fails instead of running
#   - the API URL is accepted only as an exact loopback endpoint on the
#     reserved port: no foreign host, no fragment, no path, no credentials
#   - no failure path prints a value it was handed
#
# Every fixture is SYNTHETIC. No real credential, host or key appears here.
#
# Usage:  sh scripts/test-integration-db-local.test.sh
#
# The libraries and the harness are read from $root by default.
# INTEGRATION_ENV_LIB_UNDER_TEST, INTEGRATION_URL_LIB_UNDER_TEST and
# INTEGRATION_HARNESS_UNDER_TEST point the suite at substitutes, so a
# deliberately regressed implementation (main's pre-fix derivation, say) can be
# checked for turning this suite red rather than assumed to.

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
env_lib="${INTEGRATION_ENV_LIB_UNDER_TEST:-$root/scripts/lib/derive-isolated-supabase-env.sh}"
url_lib="${INTEGRATION_URL_LIB_UNDER_TEST:-$root/scripts/lib/assert-isolated-supabase-url.sh}"

for lib in "$env_lib" "$url_lib"; do
  [ -r "$lib" ] || {
    echo "missing library under test: $lib" >&2
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

# Ports the harness reserves for the isolated stack, and the Supabase CLI's
# default local ports — the ones an inherited value would most likely name.
API_PORT=55421
DB_PORT=55422
SHARED_API=54321
SHARED_DB=54322

# A synthetic `supabase status -o env` payload for the isolated stack, in the
# CLI generation the harness reads. Values are obvious fixtures.
status_env_current="API_URL=\"http://127.0.0.1:$API_PORT\"
ANON_KEY=\"fixture-anon-key\"
SERVICE_ROLE_KEY=\"fixture-service-role-key\"
JWT_SECRET=\"fixture-jwt-secret\"
DB_URL=\"postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres\""

# The newer generation, where the CLI renamed the key variables.
status_env_renamed="API_URL=\"http://127.0.0.1:$API_PORT\"
PUBLISHABLE_KEY=\"fixture-publishable-key\"
SECRET_KEY=\"fixture-secret-key\"
AUTH_JWT_SECRET=\"fixture-auth-jwt-secret\""

# Run one derivation in a clean bash, with the given ambient assignments in
# force, and print the resulting endpoints one per line. Anything the caller
# wants to assert about stdout/stderr comes back too.
derive() { # ambient_prelude status_env  -> "SUPABASE_URL|INTEGRATION_DB_URL|SECRET|PUBLISHABLE|JWT"
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" bash -c '
    set -u
    eval "$1"
    source "$2"
    derive_isolated_supabase_env "$3" "$4" "$5" || exit 1
    printf "%s|%s|%s|%s|%s\n" "$SUPABASE_URL" "$INTEGRATION_DB_URL" \
      "$SUPABASE_SECRET_KEY" "$SUPABASE_PUBLISHABLE_KEY" "$JWT_SECRET"
  ' _ "$1" "$env_lib" "$2" "$API_PORT" "$DB_PORT" 2>/dev/null
}

# Same, but capture stderr and the exit code instead of the endpoints.
derive_err() { # ambient_prelude status_env -> stderr, sets rc
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" bash -c '
    set -u
    eval "$1"
    source "$2"
    derive_isolated_supabase_env "$3" "$4" "$5"
  ' _ "$1" "$env_lib" "$2" "$API_PORT" "$DB_PORT" 2>&1 >/dev/null
}

field() { echo "$1" | cut -d'|' -f"$2"; }

echo "ENV DERIVATION (scripts/lib/derive-isolated-supabase-env.sh)"

# The contamination shape: a shell that already carries another local stack's
# URL and keys. This is the assertion that fails against main.
ambient_full="export SUPABASE_URL=http://127.0.0.1:$SHARED_API
export SUPABASE_SECRET_KEY=ambient-secret-key
export SUPABASE_PUBLISHABLE_KEY=ambient-publishable-key
export JWT_SECRET=ambient-jwt-secret
export DB_URL=postgresql://postgres:postgres@127.0.0.1:$SHARED_DB/postgres"

out=$(derive "$ambient_full" "$status_env_current")
got_api=$(field "$out" 1)
[ "$got_api" = "http://127.0.0.1:$API_PORT" ] &&
  ok "an ambient SUPABASE_URL does not survive into the API endpoint" ||
  bad "an ambient SUPABASE_URL does not survive into the API endpoint" "got '$got_api'"

got_db=$(field "$out" 2)
[ "$got_db" = "postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres" ] &&
  ok "an ambient DB_URL does not survive into INTEGRATION_DB_URL" ||
  bad "an ambient DB_URL does not survive into INTEGRATION_DB_URL" "got '$got_db'"

# The bug was not either endpoint alone — it was the two disagreeing. Assert
# the relationship directly, so a future change that breaks only one is caught
# by the property and not only by the two literals above.
api_port_seen=$(echo "$got_api" | sed -n 's|.*:\([0-9]*\)$|\1|p')
db_port_seen=$(echo "$got_db" | sed -n 's|.*:\([0-9]*\)/postgres$|\1|p')
if [ "$api_port_seen" = "$API_PORT" ] && [ "$db_port_seen" = "$DB_PORT" ]; then
  ok "both endpoints address the reserved stack (no split target)"
else
  bad "both endpoints address the reserved stack (no split target)" \
    "API on :$api_port_seen, direct PG on :$db_port_seen"
fi

got_secret=$(field "$out" 3)
[ "$got_secret" = "fixture-service-role-key" ] &&
  ok "an ambient SUPABASE_SECRET_KEY does not survive" ||
  bad "an ambient SUPABASE_SECRET_KEY does not survive" "got '$got_secret'"

got_pub=$(field "$out" 4)
[ "$got_pub" = "fixture-anon-key" ] &&
  ok "an ambient SUPABASE_PUBLISHABLE_KEY does not survive" ||
  bad "an ambient SUPABASE_PUBLISHABLE_KEY does not survive" "got '$got_pub'"

got_jwt=$(field "$out" 5)
[ "$got_jwt" = "fixture-jwt-secret" ] &&
  ok "an ambient JWT_SECRET does not survive" ||
  bad "an ambient JWT_SECRET does not survive" "got '$got_jwt'"

# A shell carrying the OLD generation's names must not have them read as the
# stack's, either — these are unset before the status output is evaluated.
ambient_aliases="export API_URL=http://127.0.0.1:$SHARED_API
export SERVICE_ROLE_KEY=ambient-service-role
export ANON_KEY=ambient-anon
export SECRET_KEY=ambient-secret
export PUBLISHABLE_KEY=ambient-publishable
export AUTH_JWT_SECRET=ambient-auth-jwt"
out=$(derive "$ambient_aliases" "$status_env_current")
if [ "$(field "$out" 1)" = "http://127.0.0.1:$API_PORT" ] &&
  [ "$(field "$out" 3)" = "fixture-service-role-key" ]; then
  ok "ambient CLI-alias names (API_URL/SERVICE_ROLE_KEY/...) do not survive"
else
  bad "ambient CLI-alias names do not survive" "got '$out'"
fi

# The cases above are only half the contamination surface, and the weaker
# half: when the status output emits a name, evaluating it overwrites the
# ambient value and an inherited fallback never fires. The fallback fires when
# the stack does NOT emit that name — an excluded container, a CLI that
# renamed it — and then the ambient value is what the suite runs against, with
# every required-field check satisfied. Each case below withholds exactly one
# name from the status output while the shell carries it.

out=$(derive "$ambient_full" "API_URL=\"http://127.0.0.1:$API_PORT\"
SERVICE_ROLE_KEY=\"fixture-service-role-key\"
JWT_SECRET=\"fixture-jwt-secret\"")
got_db=$(field "$out" 2)
[ "$got_db" = "postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres" ] &&
  ok "an ambient DB_URL does not survive when status omits DB_URL" ||
  bad "an ambient DB_URL does not survive when status omits DB_URL" "got '$got_db'"

err=$(derive_err "$ambient_full" "API_URL=\"http://127.0.0.1:$API_PORT\"
JWT_SECRET=\"fixture-jwt-secret\"")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "an ambient secret key cannot satisfy a status output that omits it" ||
  bad "an ambient secret key cannot satisfy a status output that omits it" \
    "accepted — the suite would have run on the ambient key"

err=$(derive_err "$ambient_full" "API_URL=\"http://127.0.0.1:$API_PORT\"
SERVICE_ROLE_KEY=\"fixture-service-role-key\"")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "an ambient JWT secret cannot satisfy a status output that omits it" ||
  bad "an ambient JWT secret cannot satisfy a status output that omits it" \
    "accepted — the suite would have run on the ambient secret"

out=$(derive "$ambient_aliases" "JWT_SECRET=\"fixture-jwt-secret\"
API_URL=\"http://127.0.0.1:$API_PORT\"
SERVICE_ROLE_KEY=\"fixture-service-role-key\"")
got_pub=$(field "$out" 4)
[ "$got_pub" = "" ] &&
  ok "an ambient ANON_KEY does not survive when status omits it" ||
  bad "an ambient ANON_KEY does not survive when status omits it" "got '$got_pub'"

# Either CLI generation is accepted on a clean shell.
out=$(derive "true" "$status_env_renamed")
if [ "$(field "$out" 3)" = "fixture-secret-key" ] &&
  [ "$(field "$out" 4)" = "fixture-publishable-key" ] &&
  [ "$(field "$out" 5)" = "fixture-auth-jwt-secret" ]; then
  ok "the renamed CLI generation (SECRET_KEY/PUBLISHABLE_KEY/AUTH_JWT_SECRET) is read"
else
  bad "the renamed CLI generation is read" "got '$out'"
fi

echo ""
echo "MISSING STATUS FIELDS"

# A status output missing the API URL must fail — and must not be rescued by
# an ambient one, which is the path by which a foreign stack gets addressed.
err=$(derive_err "$ambient_full" "SERVICE_ROLE_KEY=\"fixture-service-role-key\"
JWT_SECRET=\"fixture-jwt-secret\"")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "a status output with no API_URL fails instead of running" ||
  bad "a status output with no API_URL fails instead of running" "exit $rc"
echo "$err" | grep -q 'Failed to derive required env vars' &&
  ok "the missing-field refusal says what it could not derive" ||
  bad "the missing-field refusal says what it could not derive" "$(echo "$err" | tr '\n' ' ')"

err=$(derive_err "true" "API_URL=\"http://127.0.0.1:$API_PORT\"
JWT_SECRET=\"fixture-jwt-secret\"")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "a status output with no service-role key fails instead of running" ||
  bad "a status output with no service-role key fails instead of running" "exit $rc"

err=$(derive_err "true" "API_URL=\"http://127.0.0.1:$API_PORT\"
SERVICE_ROLE_KEY=\"fixture-service-role-key\"")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "a status output with no JWT secret fails instead of running" ||
  bad "a status output with no JWT secret fails instead of running" "exit $rc"

err=$(derive_err "true" "$status_env_current")
rc=$?
[ "$rc" -eq 0 ] &&
  ok "a complete status output is accepted (control)" ||
  bad "a complete status output is accepted (control)" "exit $rc: $(echo "$err" | tr '\n' ' ')"

echo ""
echo "FAILURE-OUTPUT REDACTION"

# The refusal runs holding the stack's service-role key and JWT secret. It
# reports the NAMES; the values must not reach the log.
err=$(derive_err "true" "SERVICE_ROLE_KEY=\"fixture-service-role-key\"
JWT_SECRET=\"fixture-jwt-secret\"
ANON_KEY=\"fixture-anon-key\"")
leaked=""
for v in fixture-service-role-key fixture-jwt-secret fixture-anon-key; do
  echo "$err" | grep -q -- "$v" && leaked="$leaked $v"
done
[ -z "$leaked" ] &&
  ok "the missing-field refusal prints no value from the status output" ||
  bad "the missing-field refusal prints no value from the status output" "leaked:$leaked"

if echo "$err" | grep -q 'SERVICE_ROLE_KEY=<redacted>' &&
  echo "$err" | grep -q 'JWT_SECRET=<redacted>'; then
  ok "the missing-field refusal still names the variables it saw"
else
  bad "the missing-field refusal still names the variables it saw" "$(echo "$err" | tr '\n' ' ')"
fi

# A status line that is not an assignment must not be echoed either.
err=$(derive_err "true" "some unexpected banner text
SERVICE_ROLE_KEY=\"fixture-service-role-key\"")
echo "$err" | grep -q 'unexpected banner text' &&
  bad "a non-assignment status line is not echoed" "$(echo "$err" | tr '\n' ' ')" ||
  ok "a non-assignment status line is not echoed"

# The redactor above only sees what we hand it. `eval` has a mouth of its own:
# a line bash cannot parse is echoed by bash, value and all, before any
# redactor runs.
err=$(derive_err "true" "SERVICE_ROLE_KEY=zneval )")
echo "$err" | grep -q 'zneval' &&
  bad "a status line bash cannot parse is not echoed by eval" "$(echo "$err" | tr '\n' ' ')" ||
  ok "a status line bash cannot parse is not echoed by eval"

echo ""
echo "PARTIAL EVALUATION"

# bash evaluates a multi-line string command by command, so a malformed line
# only stops what follows it. When the required fields all land BEFORE the
# error, every check downstream is satisfied and the payload passes — on a
# status output that did not evaluate. The call shape is the harness's own:
# `... || exit 1` under `set -euo pipefail`, which is exactly the shape that
# suppresses errexit for the function body.
derive_harness_shape() { # status_env -> stderr, sets rc
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" bash -c '
    set -euo pipefail
    source "$1"
    derive_isolated_supabase_env "$2" "$3" "$4" || exit 1
  ' _ "$env_lib" "$1" "$API_PORT" "$DB_PORT" 2>&1 >/dev/null
}

err=$(derive_harness_shape "$status_env_current
UNUSED_KEY=znlate )")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "a malformed line AFTER the required fields is refused, not accepted" ||
  bad "a malformed line AFTER the required fields is refused, not accepted" \
    "accepted — the suite would have run on a status output that did not evaluate"

echo "$err" | grep -q 'znlate' &&
  bad "the late-malformed refusal prints no value" "$(echo "$err" | tr '\n' ' ')" ||
  ok "the late-malformed refusal prints no value"

# Control: a value containing the same character, properly quoted, is valid
# status output and must still be accepted. Without this, refusing everything
# would pass the two assertions above.
err=$(derive_harness_shape "API_URL=\"http://127.0.0.1:$API_PORT\"
SERVICE_ROLE_KEY=\"fixture-key-with-)-inside\"
JWT_SECRET=\"fixture-jwt-secret\"")
rc=$?
[ "$rc" -eq 0 ] &&
  ok "a quoted value containing ')' is still accepted (control)" ||
  bad "a quoted value containing ')' is still accepted (control)" \
    "exit $rc: $(echo "$err" | tr '\n' ' ')"

echo ""
echo "EXACT ENDPOINT CHECK (scripts/lib/assert-isolated-supabase-url.sh)"

assert_url() { # url port -> stderr, sets rc
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" bash -c '
    source "$1"
    assert_isolated_supabase_url "$2" "$3"
  ' _ "$url_lib" "$1" "$2" 2>&1 >/dev/null
}

accepts() { # label url
  out=$(assert_url "$2" "$API_PORT")
  rc=$?
  [ "$rc" -eq 0 ] && ok "$1" || bad "$1" "exit $rc: $(echo "$out" | tr '\n' ' ')"
}
rejects() { # label url
  out=$(assert_url "$2" "$API_PORT")
  rc=$?
  [ "$rc" -ne 0 ] && ok "$1" || bad "$1" "accepted"
}

accepts "the exact isolated endpoint is accepted (control)" "http://127.0.0.1:$API_PORT"
rejects "the shared stack's endpoint is rejected" "http://127.0.0.1:$SHARED_API"
rejects "a foreign host carrying the reserved port is rejected" "https://foreign.invalid:$API_PORT"
rejects "a fragment that merely contains the port is rejected" "http://127.0.0.1:$SHARED_API/#:$API_PORT"
rejects "a query that merely contains the port is rejected" "http://127.0.0.1:$SHARED_API/?p=$API_PORT"
rejects "credentials before the host are rejected" "http://user:pw@127.0.0.1:$API_PORT"
rejects "a trailing slash is rejected" "http://127.0.0.1:$API_PORT/"
rejects "a path is rejected" "http://127.0.0.1:$API_PORT/rest/v1"
rejects "https on the reserved port is rejected" "https://127.0.0.1:$API_PORT"
rejects "the hostname 'localhost' is rejected" "http://localhost:$API_PORT"
rejects "a host whose name ends in the loopback literal is rejected" "http://evil127.0.0.1:$API_PORT"
rejects "an empty URL is rejected" ""

out=$(assert_url "http://127.0.0.1:$API_PORT" "not-a-port")
rc=$?
[ "$rc" -ne 0 ] &&
  ok "a non-numeric reserved port is rejected" ||
  bad "a non-numeric reserved port is rejected" "accepted"

out=$(assert_url "http://fixtureuser:fixturepw@127.0.0.1:$SHARED_API/p?apikey=fixturekey" "$API_PORT")
echo "$out" | grep -q "expected exactly: http://127.0.0.1:$API_PORT" &&
  ok "the rejection names the endpoint it wanted" ||
  bad "the rejection names the endpoint it wanted" "$(echo "$out" | tr '\n' ' ')"

# THE CONTRACT: no part of a rejected URL reaches the diagnostic.
#
# This replaces a set of per-component assertions that pinned the previous
# design — a sanitiser that printed scheme://host:port and named the parts it
# had dropped. Each component got its own case, and each case used a word that
# also appeared in a component the same case was not testing, so a component
# escaping through the wrong branch still satisfied the assertion. Every case
# below tags EVERY component with a sentinel unique to it, and the assertion
# is a property over all of them: whatever the parse does, none of these
# strings may appear in the output.
#
# Cases 1, 6 and 7 pass against the previous design too. They are controls:
# they show the battery can pass, so the four that go red are the finding and
# not the harness refusing everything.
hostile_urls="\
1|http://znuser:znpw@127.0.0.1:$SHARED_API/znpath?k=znquery#znfrag
2|http://127.0.0.1:$SHARED_API/path@znpath
3|http://znuser@znpw@127.0.0.1:$API_PORT
4|znscheme://127.0.0.1:$API_PORT
5|http://znhost:$API_PORT
6|http://127.0.0.1:$API_PORT#@znfrag
7|znpath"

echo "$hostile_urls" | while IFS='|' read -r n url; do
  [ -z "$url" ] && continue
  out=$(assert_url "$url" "$API_PORT")
  rc=$?
  echo "RAN|$n"
  [ "$rc" -eq 0 ] && echo "ACCEPTED|$n"
  for v in znuser znpw znhost znpath znquery znfrag znscheme; do
    echo "$out" | grep -q -- "$v" && echo "LEAK|$n|$v"
  done
done >"${TMPDIR:-/tmp}/zn_url_leaks.$$"

# The loop runs in a subshell behind a pipe, so it cannot report upward except
# through this file. A battery that silently iterated zero times would leave
# the file empty and read as a pass — count the cases before trusting the
# absence of leaks.
ran=$(grep -c '^RAN|' "${TMPDIR:-/tmp}/zn_url_leaks.$$")
[ "$ran" -eq 7 ] &&
  ok "all 7 hostile URL shapes were exercised" ||
  bad "all 7 hostile URL shapes were exercised" "only $ran ran"

leaks=$(grep -cv '^RAN|' "${TMPDIR:-/tmp}/zn_url_leaks.$$")
if [ "$leaks" -eq 0 ]; then
  ok "no component of a rejected URL appears in the refusal (7 hostile shapes)"
else
  bad "no component of a rejected URL appears in the refusal (7 hostile shapes)" \
    "$(grep -v '^RAN|' "${TMPDIR:-/tmp}/zn_url_leaks.$$" | tr '\n' ' ')"
fi
rm -f "${TMPDIR:-/tmp}/zn_url_leaks.$$"

echo ""
echo "HARNESS WIRING (scripts/test-integration-db-local.sh)"

harness="${INTEGRATION_HARNESS_UNDER_TEST:-$root/scripts/test-integration-db-local.sh}"
[ -r "$harness" ] || {
  echo "missing harness under test: $harness" >&2
  exit 1
}
grep -q 'derive_isolated_supabase_env' "$harness" &&
  ok "the harness derives its env through the library" ||
  bad "the harness derives its env through the library"
grep -q 'assert_isolated_supabase_url' "$harness" &&
  ok "the harness asserts its endpoint through the library" ||
  bad "the harness asserts its endpoint through the library"
grep -qE '^\s*export (SUPABASE_URL|INTEGRATION_DB_URL)=.*\$\{(SUPABASE_URL|DB_URL):-' "$harness" &&
  bad "the harness no longer falls back to an inherited endpoint" "an ambient fallback is still present" ||
  ok "the harness no longer falls back to an inherited endpoint"
grep -qE '^\s*echo "\$\{STATUS_ENV\}" >&2' "$harness" &&
  bad "the harness never echoes the raw status output" "a raw dump is still present" ||
  ok "the harness never echoes the raw status output"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
