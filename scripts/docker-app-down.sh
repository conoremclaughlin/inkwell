#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

exec docker compose -f "${ROOT_DIR}/docker-compose.app.yml" down --remove-orphans "${@}"
