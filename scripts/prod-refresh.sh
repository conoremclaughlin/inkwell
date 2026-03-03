#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[prod-refresh] Installing dependencies..."
yarn install --immutable

echo "[prod-refresh] Building all packages..."
yarn build

echo "[prod-refresh] ✅ Build complete."
echo "[prod-refresh] Restart your running server process to pick up the latest code."
echo "[prod-refresh] - PM2 mode: yarn restart"
echo "[prod-refresh] - Direct mode: stop/re-run yarn prod:direct"

