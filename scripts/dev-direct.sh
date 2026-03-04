#!/usr/bin/env bash
set -euo pipefail

# Force Yarn to operate against this worktree (avoids cross-worktree PROJECT_CWD bleed).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROJECT_CWD="${ROOT_DIR}"
export INIT_CWD="${ROOT_DIR}"

# Preserve caller-provided env so explicit CLI overrides win over .env files.
PRESERVED_ENV_FILE="$(mktemp)"
while IFS='=' read -r key value; do
  printf 'export %s=%q\n' "${key}" "${value}" >>"${PRESERVED_ENV_FILE}"
done < <(env)

cleanup() {
  if [[ -n "${PRESERVED_ENV_FILE:-}" ]]; then rm -f "${PRESERVED_ENV_FILE}" 2>/dev/null || true; fi
  if [[ -n "${API_PID:-}" ]]; then kill "${API_PID}" 2>/dev/null || true; fi
  if [[ -n "${WEB_PID:-}" ]]; then kill "${WEB_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

load_env_file() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}"
    set +a
  fi
}

# Load root env files so both API + web get a consistent local dev environment.
load_env_file "${ROOT_DIR}/.env.local"
load_env_file "${ROOT_DIR}/.env"

# Restore original environment values from the caller (prefix assignments, exported vars).
# shellcheck disable=SC1090
source "${PRESERVED_ENV_FILE}"

if command -v supabase >/dev/null 2>&1; then
  node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --warn-only || true
else
  echo "[migrations] ⚠ Supabase CLI not found; cannot check linked migration status."
fi

# Run API + web directly (no PM2), useful for parallel worktrees.
BASE_PORT="${PCP_PORT_BASE:-3001}"
WEB_PORT="${WEB_PORT:-$((BASE_PORT + 1))}"
MYRA_PORT="${MYRA_HTTP_PORT:-$((BASE_PORT + 2))}"
ENABLE_TELEGRAM="${ENABLE_TELEGRAM:-false}"
API_URL="${API_URL:-http://localhost:${BASE_PORT}}"

echo "Starting direct dev mode"
echo "  PCP_PORT_BASE=${BASE_PORT}"
echo "  WEB_PORT=${WEB_PORT}"
echo "  MYRA_HTTP_PORT=${MYRA_PORT}"
echo "  ENABLE_TELEGRAM=${ENABLE_TELEGRAM}"
echo "  ENABLE_HEARTBEATS=${ENABLE_HEARTBEATS:-<unset>}"
echo "  ENABLE_REMINDERS=${ENABLE_REMINDERS:-<unset>}"
echo "  API_URL=${API_URL}"

(
  PCP_PORT_BASE="${BASE_PORT}" \
  MYRA_HTTP_PORT="${MYRA_PORT}" \
  API_URL="${API_URL}" \
  ENABLE_TELEGRAM="${ENABLE_TELEGRAM}" \
  ENABLE_WHATSAPP="${ENABLE_WHATSAPP:-false}" \
  ENABLE_DISCORD="${ENABLE_DISCORD:-false}" \
  yarn --cwd "${ROOT_DIR}" workspace @personal-context/api server:dev
) &
API_PID=$!

# Ensure API actually boots before starting web (avoids silent ECONNREFUSED loops).
wait_for_api() {
  local health_url="${API_URL}/health"
  local attempts=30

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      echo "  API health check passed at ${health_url}"
      return 0
    fi

    if ! kill -0 "${API_PID}" 2>/dev/null; then
      echo "ERROR: API process exited before becoming healthy (pid=${API_PID})"
      wait "${API_PID}" || true
      return 1
    fi

    sleep 1
  done

  echo "ERROR: API did not become healthy within ${attempts}s (${health_url})"
  return 1
}

wait_for_api

(
  API_URL="${API_URL}" \
  yarn --cwd "${ROOT_DIR}" workspace @personal-context/web exec next dev -p "${WEB_PORT}"
) &
WEB_PID=$!

wait "${API_PID}" "${WEB_PID}"
