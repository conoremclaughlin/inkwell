#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if command -v supabase >/dev/null 2>&1; then
  node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --warn-only || true
else
  echo "[migrations] ⚠ Supabase CLI not found; cannot check linked migration status."
fi

echo "[dev] Starting PM2 ecosystem..."
exec pm2 start "${ROOT_DIR}/ecosystem.config.cjs"
