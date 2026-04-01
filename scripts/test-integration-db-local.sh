#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR_BASE="${INTEGRATION_SUPABASE_WORKDIR_BASE:-${TMPDIR:-/tmp}}"
TEMP_DIR="$(mktemp -d "${WORKDIR_BASE%/}/pcp-supabase-it-XXXXXX")"
SUPABASE_WORKDIR="${TEMP_DIR}"
SUPABASE_DIR="${SUPABASE_WORKDIR}/supabase"
CONFIG_PATH="${SUPABASE_DIR}/config.toml"

# Keep this stack isolated from any existing local/remote setup.
API_PORT="${INTEGRATION_SUPABASE_API_PORT:-55421}"
DB_PORT="${INTEGRATION_SUPABASE_DB_PORT:-55422}"
STUDIO_PORT="${INTEGRATION_SUPABASE_STUDIO_PORT:-55423}"
INBUCKET_PORT="${INTEGRATION_SUPABASE_INBUCKET_PORT:-55424}"
INBUCKET_SMTP_PORT="${INTEGRATION_SUPABASE_INBUCKET_SMTP_PORT:-55425}"
INBUCKET_POP3_PORT="${INTEGRATION_SUPABASE_INBUCKET_POP3_PORT:-55426}"
PROJECT_ID="${INTEGRATION_SUPABASE_PROJECT_ID:-pcp-integration}"
EXCLUDED_CONTAINERS="${INTEGRATION_SUPABASE_EXCLUDE:-studio,mailpit,logflare,vector,supavisor}"

cleanup() {
  if [[ "${INTEGRATION_KEEP_SUPABASE:-0}" == "1" ]]; then
    echo "[integration-db] Leaving local Supabase running for inspection (INTEGRATION_KEEP_SUPABASE=1)."
    echo "[integration-db] workdir=${SUPABASE_WORKDIR}"
    return
  fi

  if command -v supabase >/dev/null 2>&1; then
    supabase stop --workdir "${SUPABASE_WORKDIR}" --no-backup >/dev/null 2>&1 || true
  fi

  rm -rf "${TEMP_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required. Install via: brew install supabase/tap/supabase" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run local Supabase integration tests." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but the daemon is not running." >&2
  echo "Start Docker Desktop (or your docker daemon) and retry." >&2
  exit 1
fi

echo "[integration-db] Preparing isolated Supabase workdir: ${SUPABASE_WORKDIR}"
cp -R "${ROOT_DIR}/supabase" "${SUPABASE_DIR}"

python3 - "$CONFIG_PATH" "$API_PORT" "$DB_PORT" "$STUDIO_PORT" "$INBUCKET_PORT" "$INBUCKET_SMTP_PORT" "$INBUCKET_POP3_PORT" "$PROJECT_ID" <<'PY'
import pathlib
import re
import sys

config_path = pathlib.Path(sys.argv[1])
api_port = sys.argv[2]
db_port = sys.argv[3]
studio_port = sys.argv[4]
inbucket_port = sys.argv[5]
smtp_port = sys.argv[6]
pop3_port = sys.argv[7]
project_id = sys.argv[8]

text = config_path.read_text()
text = re.sub(r'(?m)^(port\s*=\s*)54321$', rf'\g<1>{api_port}', text)
text = re.sub(r'(?m)^(port\s*=\s*)54322$', rf'\g<1>{db_port}', text)
text = re.sub(r'(?m)^(port\s*=\s*)54323$', rf'\g<1>{studio_port}', text)
text = re.sub(r'(?m)^(port\s*=\s*)54324$', rf'\g<1>{inbucket_port}', text)
text = re.sub(r'(?m)^(smtp_port\s*=\s*)54325$', rf'\g<1>{smtp_port}', text)
text = re.sub(r'(?m)^(pop3_port\s*=\s*)54326$', rf'\g<1>{pop3_port}', text)

if re.search(r'(?m)^project_id\s*=', text):
  text = re.sub(r'(?m)^project_id\s*=.*$', f'project_id = "{project_id}"', text)
else:
  text = f'project_id = "{project_id}"\n\n{text}'

config_path.write_text(text)
PY

echo "[integration-db] Starting isolated Supabase stack..."
supabase start --workdir "${SUPABASE_WORKDIR}" --exclude "${EXCLUDED_CONTAINERS}" >/dev/null

echo "[integration-db] Resetting DB (migrations + seed)..."
supabase db reset --workdir "${SUPABASE_WORKDIR}" --local >/dev/null

echo "[integration-db] Exporting local Supabase env..."
STATUS_ENV="$(supabase status --workdir "${SUPABASE_WORKDIR}" -o env)"
eval "${STATUS_ENV}"

export SUPABASE_URL="${SUPABASE_URL:-${API_URL:-}}"
export SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-${ANON_KEY:-}}"
export SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY:-${SERVICE_ROLE_KEY:-}}"
export JWT_SECRET="${JWT_SECRET:-${AUTH_JWT_SECRET:-}}"
export NODE_ENV="test"
export INK_ALLOW_REMOTE_INTEGRATION_DB="0"
export INTEGRATION_SUPABASE_WORKDIR="${SUPABASE_WORKDIR}"

if [[ -z "${SUPABASE_URL}" || -z "${SUPABASE_SECRET_KEY}" || -z "${JWT_SECRET}" ]]; then
  echo "[integration-db] Failed to derive required env vars from supabase status output." >&2
  echo "${STATUS_ENV}" >&2
  exit 1
fi

echo "[integration-db] Running API DB integration suite against ${SUPABASE_URL}"
yarn --cwd "${ROOT_DIR}" workspace @inkstand/api test:integration:db

echo "[integration-db] ✅ Integration DB tests passed."
