#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# Production mode for every step below, the migration step included: the
# runtime prod:direct starts is production whatever the caller's shell says,
# so the stack that is proven must be production's too.
export NODE_ENV=production

echo "[prod-up] Refreshing build artifacts..."
yarn prod:refresh

echo "[prod-up] Applying linked database migrations..."
yarn prod:migrate

echo "[prod-up] Starting direct production runtime..."
exec yarn prod:direct
