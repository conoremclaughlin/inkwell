#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE_PORT="${PCP_PORT_BASE:-3001}"
WEB_PORT="${WEB_PORT:-$((BASE_PORT + 1))}"
MYRA_HTTP_PORT="${MYRA_HTTP_PORT:-$((BASE_PORT + 2))}"
API_URL="${API_URL:-http://localhost:${BASE_PORT}}"

echo "Starting concurrent dev mode"
echo "  PCP_PORT_BASE=${BASE_PORT}"
echo "  WEB_PORT=${WEB_PORT}"
echo "  MYRA_HTTP_PORT=${MYRA_HTTP_PORT}"
echo "  API_URL=${API_URL}"
echo "  ENABLE_TELEGRAM=${ENABLE_TELEGRAM:-<auto>}"
echo "  ENABLE_HEARTBEAT_SERVICE=${ENABLE_HEARTBEAT_SERVICE:-<unset>}"

exec concurrently -k -n api,web -c blue,magenta \
  "PCP_PORT_BASE=${BASE_PORT} MYRA_HTTP_PORT=${MYRA_HTTP_PORT} API_URL=${API_URL} ENABLE_TELEGRAM=${ENABLE_TELEGRAM:-} ENABLE_WHATSAPP=${ENABLE_WHATSAPP:-false} ENABLE_DISCORD=${ENABLE_DISCORD:-false} yarn --cwd \"${ROOT_DIR}\" workspace @personal-context/api server:dev" \
  "PCP_PORT_BASE=${BASE_PORT} WEB_PORT=${WEB_PORT} API_URL=${API_URL} yarn --cwd \"${ROOT_DIR}\" workspace @personal-context/web dev"
