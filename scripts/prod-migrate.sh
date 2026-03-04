#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "[prod-migrate] Missing Supabase CLI."
  echo "[prod-migrate] Install: https://supabase.com/docs/guides/cli/getting-started"
  exit 1
fi

echo "[prod-migrate] Checking migration status..."
set +e
node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}"
status_code=$?
set -e

target="$(node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --print-target 2>/dev/null || echo linked)"
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
node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}"
echo "[prod-migrate] ✅ ${target} migrations are up to date."
