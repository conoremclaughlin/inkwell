#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-/home/sb}"
mkdir -p \
  "${HOME_DIR}" \
  "${HOME_DIR}/.claude" \
  "${HOME_DIR}/.codex" \
  "${HOME_DIR}/.gemini"

exec /usr/bin/tini -s -- "$@"
