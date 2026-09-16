#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Executed normally, the Python parent owns locks and stack lifecycle. When
# sourced by that parent, run only env derivation and the suite. Keeping these
# together preserves the endpoint safety checks for both cold and warm runs.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  exec python3 "${ROOT_DIR}/scripts/lib/integration-stack.py" "${BASH_SOURCE[0]}" "$@"
fi
SUPABASE_WORKDIR="${INTEGRATION_MANAGED_WORKDIR:?Use the managed harness entry point}"
API_PORT="${INTEGRATION_MANAGED_API_PORT:?Missing managed API port}"
DB_PORT="${INTEGRATION_MANAGED_DB_PORT:?Missing managed DB port}"
PROJECT_ID="${INTEGRATION_SUPABASE_PROJECT_ID:-pcp-integration}"

echo "[integration-db] Exporting local Supabase env..."
STATUS_ENV="$(supabase status --workdir "${SUPABASE_WORKDIR}" -o env)"

# Both endpoints come from the stack this script started, and from nothing the
# calling shell already had. See the library for why inheriting them is unsafe.
# shellcheck source=lib/derive-isolated-supabase-env.sh
source "${ROOT_DIR}/scripts/lib/derive-isolated-supabase-env.sh"
derive_isolated_supabase_env "${STATUS_ENV}" "${API_PORT}" "${DB_PORT}" || exit 1

export NODE_ENV="test"
export INK_ALLOW_REMOTE_INTEGRATION_DB="0"
export INTEGRATION_SUPABASE_WORKDIR="${SUPABASE_WORKDIR}"

# Prove the target before a single test runs: the API URL must be exactly the
# loopback endpoint on the port this script reserved — not merely contain the
# port (Lumen, #623: a substring test passed foreign hosts and fragments). The
# check lives in scripts/lib so it can be tested alone.
# shellcheck source=lib/assert-isolated-supabase-url.sh
source "${ROOT_DIR}/scripts/lib/assert-isolated-supabase-url.sh"
assert_isolated_supabase_url "${SUPABASE_URL}" "${API_PORT}" || exit 1

# Non-empty is not the same as service-role. A key that parses but resolves to
# `anon` sails past the non-empty check and then fails every single test with
# "permission denied for table users" — 100+ confusing failures for one bad
# variable. That is exactly how this job stayed red from June to August 2026
# without anyone being able to read the cause off the log. Probe once, here.
echo "[integration-db] Verifying the derived key has service-role access..."
PROBE_STATUS="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  "${SUPABASE_URL}/rest/v1/users?select=id&limit=1" || echo "000")"

if [[ "${PROBE_STATUS}" != "200" ]]; then
  echo "[integration-db] Derived key cannot read public.users (HTTP ${PROBE_STATUS})." >&2
  echo "[integration-db] SUPABASE_SECRET_KEY is present but is not a service-role key." >&2
  echo "[integration-db] Most likely the Supabase CLI changed its 'status -o env' output" >&2
  echo "[integration-db] and SERVICE_ROLE_KEY no longer means what this script assumes." >&2
  echo "[integration-db] CLI version in use:" >&2
  supabase --version >&2 || true
  echo "[integration-db] Keys emitted by status (values redacted):" >&2
  printf '%s\n' "${STATUS_ENV}" | redact_env_assignments >&2
  exit 1
fi

# One 200 proved the key. `db reset` also makes PostgREST reload its schema
# cache, and the gateway can still answer a request badly for a moment after
# that; ask for three clean answers a second apart before starting the suite.
# Bounded by wall-clock, not by attempts, and each request carries its own
# transfer cap: an accepted connection that never answers must not hold the
# job hostage (Lumen, #601 review — a stalled server held the attempt-bounded
# version for the full stall).
echo "[integration-db] Waiting for the REST gateway to answer steadily..."
STEADY=0
CODE="000"
SETTLE_DEADLINE=$((SECONDS + 20))
while (( SECONDS < SETTLE_DEADLINE )); do
  CODE="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    "${SUPABASE_URL}/rest/v1/users?select=id&limit=1" || echo "000")"
  if [[ "${CODE}" == "200" ]]; then STEADY=$((STEADY + 1)); else STEADY=0; fi
  if [[ "${STEADY}" -ge 3 ]]; then break; fi
  sleep 1
done
if [[ "${STEADY}" -lt 3 ]]; then
  echo "[integration-db] REST gateway did not answer three times in a row within 20s (last HTTP ${CODE}); continuing anyway." >&2
fi

# When a suite fails, the vitest output shows the symptom — a repository call
# answered "An invalid response was received from the upstream server" — and
# nothing about the cause, because that sentence is Kong's, standing in for
# whatever PostgREST or Postgres did. Two CI failures on 2026-09-11 were
# exactly this (one advance_agent_inbox_read_pointer RPC, one task_groups
# update), both green on rerun and neither reproducible locally. Dump the
# stack's own logs before the trap tears it down, so the next blip can be
# read off the job log instead of guessed at.
dump_stack_diagnostics() {
  echo "[integration-db] ❌ Suite failed — dumping isolated stack diagnostics (project ${PROJECT_ID})."
  echo "[integration-db] --- containers ---"
  docker ps -a --filter "name=${PROJECT_ID}" --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true
  echo "[integration-db] --- resource snapshot ---"
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null | grep "${PROJECT_ID}" || true
  if command -v free >/dev/null 2>&1; then free -m || true; fi
  for name in $(docker ps -a --filter "name=${PROJECT_ID}" --format '{{.Names}}' 2>/dev/null | grep -E '_(rest|kong|db)_' || true); do
    echo "[integration-db] --- docker logs --tail 150 ${name} ---"
    docker logs --tail 150 "${name}" 2>&1 || true
  done
  echo "[integration-db] --- end of diagnostics ---"
}

echo "[integration-db] Running API DB integration suite against ${SUPABASE_URL}"
if ! yarn --cwd "${ROOT_DIR}" workspace @inklabs/api test:integration:db "$@"; then
  dump_stack_diagnostics
  exit 1
fi

echo "[integration-db] ✅ Integration DB tests passed."
