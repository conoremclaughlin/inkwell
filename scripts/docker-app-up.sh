#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-app] Docker is required. Install Docker Desktop (or docker engine) and retry." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[docker-app] Docker is installed but the daemon is not running." >&2
  echo "[docker-app] Start Docker Desktop (or your docker daemon) and retry." >&2
  exit 1
fi

if [[ -n "${PCP_DOCKER_ENV_FILE:-}" ]]; then
  ENV_FILE="${PCP_DOCKER_ENV_FILE}"
elif [[ -f "${ROOT_DIR}/.env.docker" ]]; then
  ENV_FILE="${ROOT_DIR}/.env.docker"
elif [[ -f "${ROOT_DIR}/.env.local" ]]; then
  ENV_FILE="${ROOT_DIR}/.env.local"
elif [[ -f "${ROOT_DIR}/.env" ]]; then
  ENV_FILE="${ROOT_DIR}/.env"
else
  echo "[docker-app] No env file found." >&2
  echo "[docker-app] Create .env.docker from .env.docker.example, or set PCP_DOCKER_ENV_FILE." >&2
  exit 1
fi

echo "[docker-app] Using env file: ${ENV_FILE}"

if grep -Eq '^SUPABASE_URL=http://(localhost|127\.0\.0\.1)' "${ENV_FILE}"; then
  echo "[docker-app] ⚠ SUPABASE_URL points to localhost/127.0.0.1 in ${ENV_FILE}."
  echo "[docker-app]    From inside Docker, use host.docker.internal for host Supabase."
fi

exec docker compose \
  --env-file "${ENV_FILE}" \
  -f "${ROOT_DIR}/docker-compose.app.yml" \
  up --build "${@}"
