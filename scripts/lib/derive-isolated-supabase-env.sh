#!/usr/bin/env bash
# The isolated integration stack's connection env, derived from that stack and
# from nothing else.
#
# These exports used to fall back to whatever the calling shell already had:
# `${SUPABASE_URL:-${API_URL:-}}` for the API and `${DB_URL:-...}` for direct
# Postgres. A shell that already carries a Supabase URL for some other local
# stack fires that fallback, and the two targets come apart: PostgREST traffic
# addresses the inherited stack while the direct connection addresses the
# isolated one. Nothing downstream catches the split — the banner reports the
# isolated stack, and the hostname-locality guard in integration-setup.ts
# accepts either, since both are loopback. An environment with no ambient
# value is unaffected, so the failure mode does not reproduce in CI
# (#621/#623).
#
# So: unset every name that could have been inherited BEFORE reading the
# stack's output, and derive both endpoints from the stack alone. Whatever is
# set afterwards came from the stack. The CLI has renamed these across
# versions (ANON_KEY/PUBLISHABLE_KEY, SERVICE_ROLE_KEY/SECRET_KEY,
# JWT_SECRET/AUTH_JWT_SECRET); either generation is accepted.
#
# Sourced by scripts/test-integration-db-local.sh; testable on its own:
#
#   derive_isolated_supabase_env "$STATUS_ENV" "$API_PORT" "$DB_PORT"
#
# Exports SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
# JWT_SECRET and INTEGRATION_DB_URL into the caller's shell. Returns 1 if the
# stack did not supply the values the suite cannot run without.

# Every name the caller's environment might already hold for a Supabase
# connection, in both CLI generations. Anything added here must also be
# something the stack's own output can supply, or the suite loses it.
INHERITABLE_SUPABASE_NAMES=(
  SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY JWT_SECRET DB_URL
  API_URL ANON_KEY PUBLISHABLE_KEY SERVICE_ROLE_KEY SECRET_KEY AUTH_JWT_SECRET
)

# NAME=<redacted>, one per line. The failure paths below run with the stack's
# service-role key and JWT secret in hand, into a CI log — the names are the
# diagnostic, the values never are. A line that is not an assignment is
# reported by shape rather than echoed.
redact_env_assignments() {
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      echo "${BASH_REMATCH[1]}=<redacted>"
    else
      echo "<non-assignment line omitted>"
    fi
  done
}

derive_isolated_supabase_env() {
  local _dise_status_env="$1"
  local _dise_api_port="$2"
  local _dise_db_port="$3"

  if [[ ! "$_dise_api_port" =~ ^[0-9]+$ || ! "$_dise_db_port" =~ ^[0-9]+$ ]]; then
    echo "[integration-db] Refusing to run: reserved ports are not numeric." >&2
    return 1
  fi

  unset "${INHERITABLE_SUPABASE_NAMES[@]}"

  # `eval` is how the stack's output becomes variables, and it is also a hole
  # in the redaction below. A line bash cannot parse makes bash echo that line
  # — value included — to its own stderr, upstream of any redactor we run. So
  # its output is discarded rather than reported, and the names are reported
  # from the payload instead.
  #
  # Its result has to be checked explicitly too. bash evaluates a multi-line
  # string command by command, so a malformed line only stops the lines after
  # it: a payload whose required fields all landed before the error satisfies
  # every check below and returns 0. `set -e` does not intervene, because the
  # harness calls this function as `... || exit 1` and errexit is suppressed
  # for the whole body of a function called in an OR-list. A status payload
  # that did not evaluate cleanly is refused whole — never accepted on the
  # assignments that happened to land first (Lumen, #645).
  local _dise_eval_rc=0
  eval "${_dise_status_env}" 2>/dev/null || _dise_eval_rc=$?
  if ((_dise_eval_rc != 0)); then
    echo "[integration-db] Refusing to run: supabase status output did not evaluate cleanly (exit ${_dise_eval_rc})." >&2
    echo "[integration-db] Names emitted by status (values redacted):" >&2
    printf '%s\n' "${_dise_status_env}" | redact_env_assignments >&2
    # Whatever the partial evaluation set is not the stack's answer.
    unset "${INHERITABLE_SUPABASE_NAMES[@]}"
    return 1
  fi

  export SUPABASE_URL="${API_URL:-}"
  export SUPABASE_PUBLISHABLE_KEY="${PUBLISHABLE_KEY:-${ANON_KEY:-}}"
  export SUPABASE_SECRET_KEY="${SECRET_KEY:-${SERVICE_ROLE_KEY:-}}"
  export JWT_SECRET="${JWT_SECRET:-${AUTH_JWT_SECRET:-}}"
  # Direct Postgres URL, for the few tests that need a SECOND connection and
  # so cannot go through PostgREST — concurrency regressions where one
  # transaction must hold a row lock while another statement waits on it.
  # PostgREST gives one transaction per request and cannot express that. Same
  # rule as the API URL: the port this script reserved, never an inherited one.
  export INTEGRATION_DB_URL="postgresql://postgres:postgres@127.0.0.1:${_dise_db_port}/postgres"

  if [[ -z "${SUPABASE_URL}" || -z "${SUPABASE_SECRET_KEY}" || -z "${JWT_SECRET}" ]]; then
    echo "[integration-db] Failed to derive required env vars from supabase status output." >&2
    echo "[integration-db] Names emitted by status (values redacted):" >&2
    printf '%s\n' "${_dise_status_env}" | redact_env_assignments >&2
    return 1
  fi

  return 0
}
