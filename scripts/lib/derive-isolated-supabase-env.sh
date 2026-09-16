#!/usr/bin/env bash
# The isolated integration stack's connection env, derived from that stack and
# from nothing else.
#
# These exports used to fall back to whatever the calling shell already had:
# `${SUPABASE_URL:-${API_URL:-}}` for the API and `${DB_URL:-...}` for direct
# Postgres. Every dev shell here carries the main local stack's SUPABASE_URL
# (it is in .env.local), so the fallback fired, and the two targets came apart:
# PostgREST traffic went to the SHARED database on :54321 while the direct
# connection went to the isolated one. Fixture writes, and the deletes that
# clean them up, landed on the shared stack; the banner still named the
# isolated one, and the hostname-locality guard in integration-setup.ts passes
# either way because both are 127.0.0.1. CI has no ambient value, so CI stayed
# green while local runs failed (Lumen, #621/#623).
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
  eval "${_dise_status_env}"

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
