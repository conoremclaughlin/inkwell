#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[prod-up] Refreshing build artifacts..."
yarn prod:refresh

echo "[prod-up] Applying linked database migrations..."
yarn prod:migrate

echo "[prod-up] Starting direct production runtime..."
exec yarn prod:direct
