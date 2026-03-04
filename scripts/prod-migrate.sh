#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "[prod-migrate] Missing Supabase CLI."
  echo "[prod-migrate] Install: https://supabase.com/docs/guides/cli/getting-started"
  exit 1
fi

echo "[prod-migrate] Checking linked migration status..."
if node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" >/dev/null 2>&1; then
  echo "[prod-migrate] No pending linked migrations."
  exit 0
fi

echo "[prod-migrate] Applying linked migrations (supabase db push)..."
supabase db push --linked --workdir "${ROOT_DIR}"

echo "[prod-migrate] Re-checking migration status..."
node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}"
echo "[prod-migrate] ✅ Linked migrations are up to date."
