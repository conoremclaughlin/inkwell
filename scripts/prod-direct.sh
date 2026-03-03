#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROJECT_CWD="${ROOT_DIR}"
export INIT_CWD="${ROOT_DIR}"

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

load_env_file "${ROOT_DIR}/.env"
load_env_file "${ROOT_DIR}/.env.local"
# shellcheck disable=SC1090
source "${PRESERVED_ENV_FILE}"

if [[ ! -f "${ROOT_DIR}/packages/api/dist/server.js" ]]; then
  echo "Missing packages/api/dist/server.js."
  echo "Run: yarn prod:refresh"
  exit 1
fi

if [[ "${PCP_RUN_WEB:-true}" != "false" && ! -d "${ROOT_DIR}/packages/web/.next" ]]; then
  echo "Missing packages/web/.next build output."
  echo "Run: yarn prod:refresh"
  exit 1
fi

BASE_PORT="${PCP_PORT_BASE:-3001}"
WEB_PORT="${WEB_PORT:-$((BASE_PORT + 1))}"
MYRA_PORT="${MYRA_HTTP_PORT:-$((BASE_PORT + 2))}"
API_URL="${API_URL:-http://localhost:${BASE_PORT}}"

echo "Starting direct prod mode (no PM2)"
echo "  PCP_PORT_BASE=${BASE_PORT}"
echo "  WEB_PORT=${WEB_PORT}"
echo "  MYRA_HTTP_PORT=${MYRA_PORT}"
echo "  API_URL=${API_URL}"
echo "  PCP_RUN_WEB=${PCP_RUN_WEB:-true}"

(
  NODE_ENV="production" \
  PCP_PORT_BASE="${BASE_PORT}" \
  MYRA_HTTP_PORT="${MYRA_PORT}" \
  API_URL="${API_URL}" \
  node "${ROOT_DIR}/packages/api/dist/server.js"
) &
API_PID=$!

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

if [[ "${PCP_RUN_WEB:-true}" == "false" ]]; then
  echo "Web disabled (PCP_RUN_WEB=false). Running API only."
  wait "${API_PID}"
  exit 0
fi

(
  NODE_ENV="production" \
  WEB_PORT="${WEB_PORT}" \
  API_URL="${API_URL}" \
  yarn --cwd "${ROOT_DIR}" workspace @personal-context/web start
) &
WEB_PID=$!

wait "${API_PID}" "${WEB_PID}"
