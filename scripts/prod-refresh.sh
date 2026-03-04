#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[prod-refresh] Installing dependencies..."
yarn install --immutable

echo "[prod-refresh] Building all packages..."
yarn build

echo "[prod-refresh] ✅ Build complete."
echo "[prod-refresh] Next steps:"
echo "[prod-refresh] - Apply linked DB migrations: yarn prod:migrate"
echo "[prod-refresh] - Start direct mode: yarn prod:direct"
echo "[prod-refresh] - One-shot all-in-one flow: yarn prod:up"
echo "[prod-refresh] - PM2 mode restart: yarn restart"
