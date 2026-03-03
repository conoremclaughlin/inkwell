#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PCP_ENV_FILE:-${ROOT_DIR}/.env.local}"

require_cmd() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[supabase-setup] Missing required command: ${cmd}" >&2
    echo "[supabase-setup] ${install_hint}" >&2
    exit 1
  fi
}

upsert_env_var() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -qE "^${key}=" "${file}" 2>/dev/null; then
    awk -v k="${key}" -v v="${value}" '
      BEGIN { updated = 0 }
      $0 ~ ("^" k "=") {
        print k "=" v
        updated = 1
        next
      }
      { print }
      END {
        if (updated == 0) print k "=" v
      }
    ' "${file}" >"${file}.tmp"
    mv "${file}.tmp" "${file}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

write_with_collision_guard() {
  local canonical_key="$1"
  local fallback_local_key="$2"
  local value="$3"
  local file="$4"

  if grep -qE "^${canonical_key}=" "${file}" 2>/dev/null; then
    echo "[supabase-setup] ⚠️  ${canonical_key} already exists in ${file}; preserving it."
    echo "[supabase-setup]    Writing ${fallback_local_key} instead so local values are still available."
    upsert_env_var "${fallback_local_key}" "${value}" "${file}"
    return
  fi

  upsert_env_var "${canonical_key}" "${value}" "${file}"
}

require_cmd "supabase" "Install Supabase CLI: https://supabase.com/docs/guides/cli/getting-started"
require_cmd "docker" "Docker is required to run local Supabase. Start Docker Desktop and retry."

if ! docker info >/dev/null 2>&1; then
  echo "[supabase-setup] Docker is installed but the daemon is not running." >&2
  echo "[supabase-setup] Start Docker Desktop (or your docker daemon) and retry." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${ROOT_DIR}/.env.example" ]]; then
    cp "${ROOT_DIR}/.env.example" "${ENV_FILE}"
    echo "[supabase-setup] Created ${ENV_FILE} from .env.example"
  else
    touch "${ENV_FILE}"
    echo "[supabase-setup] Created empty ${ENV_FILE}"
  fi
fi

echo "[supabase-setup] Starting local Supabase..."
supabase start --workdir "${ROOT_DIR}" >/dev/null

echo "[supabase-setup] Applying migrations + seed..."
supabase db reset --workdir "${ROOT_DIR}" --local >/dev/null

echo "[supabase-setup] Reading local Supabase env..."
STATUS_ENV="$(supabase status --workdir "${ROOT_DIR}" -o env)"
eval "${STATUS_ENV}"

LOCAL_URL="${API_URL:-}"
LOCAL_ANON="${ANON_KEY:-}"
LOCAL_SERVICE="${SERVICE_ROLE_KEY:-}"
LOCAL_JWT="${AUTH_JWT_SECRET:-}"

if [[ -z "${LOCAL_URL}" || -z "${LOCAL_ANON}" || -z "${LOCAL_SERVICE}" || -z "${LOCAL_JWT}" ]]; then
  echo "[supabase-setup] Failed to read required values from 'supabase status -o env'." >&2
  echo "${STATUS_ENV}" >&2
  exit 1
fi

write_with_collision_guard "SUPABASE_URL" "LOCAL_SUPABASE_URL" "${LOCAL_URL}" "${ENV_FILE}"
write_with_collision_guard "SUPABASE_PUBLISHABLE_KEY" "LOCAL_SUPABASE_PUBLISHABLE_KEY" "${LOCAL_ANON}" "${ENV_FILE}"
write_with_collision_guard "SUPABASE_SECRET_KEY" "LOCAL_SUPABASE_SECRET_KEY" "${LOCAL_SERVICE}" "${ENV_FILE}"
write_with_collision_guard "JWT_SECRET" "LOCAL_JWT_SECRET" "${LOCAL_JWT}" "${ENV_FILE}"

echo "[supabase-setup] ✅ Local Supabase is ready."
echo "[supabase-setup] Environment file updated: ${ENV_FILE}"
echo "[supabase-setup] Tip: run 'yarn dev' when ready."
