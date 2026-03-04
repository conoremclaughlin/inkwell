#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

requested_target="${PCP_MIGRATION_TARGET:-auto}"
if [[ "${1:-}" == "--local" || "${1:-}" == "local" ]]; then
  requested_target="local"
elif [[ "${1:-}" == "--linked" || "${1:-}" == "linked" ]]; then
  requested_target="linked"
elif [[ "${1:-}" == "--auto" || "${1:-}" == "auto" ]]; then
  requested_target="auto"
elif [[ -n "${1:-}" ]]; then
  echo "[prod-migrate] Unknown target '${1}'. Expected one of: local, linked, auto."
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "[prod-migrate] Missing Supabase CLI."
  echo "[prod-migrate] Install: https://supabase.com/docs/guides/cli/getting-started"
  exit 1
fi

echo "[prod-migrate] Checking migration status..."
status_args=(--workdir "${ROOT_DIR}")
if [[ "${requested_target}" == "local" ]]; then
  status_args+=(--local)
elif [[ "${requested_target}" == "linked" ]]; then
  status_args+=(--linked)
fi

set +e
node "${ROOT_DIR}/scripts/migration-status.mjs" "${status_args[@]}"
status_code=$?
set -e

target="$(node "${ROOT_DIR}/scripts/migration-status.mjs" "${status_args[@]}" --print-target 2>/dev/null || echo linked)"
target="${target//$'\n'/}"
if [[ "${target}" != "local" && "${target}" != "linked" ]]; then
  target="linked"
fi

if [[ "${status_code}" -eq 0 ]]; then
  echo "[prod-migrate] No pending ${target} migrations."
  exit 0
fi

if [[ "${status_code}" -ne 10 ]]; then
  echo "[prod-migrate] Migration status check returned ${status_code}; proceeding with best-effort apply."
fi

echo "[prod-migrate] Applying ${target} migrations (supabase db push --${target})..."
supabase db push "--${target}" --workdir "${ROOT_DIR}"

echo "[prod-migrate] Re-checking migration status..."
node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --target "${target}"
echo "[prod-migrate] ✅ ${target} migrations are up to date."
