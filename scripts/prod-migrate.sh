#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

requested_target="${INK_MIGRATION_TARGET:-auto}"
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
  echo "[prod-migrate] Migration status check returned ${status_code}; refusing to apply on an unknown listing."
  exit "${status_code}"
fi

# A window migration (`-- db-migrate: window <runbook>` in its first ten
# lines) is applied inside its runbook's window, by hand, never by this
# script on either target. The wrapper owns the marker's definition.
wrapper="${ROOT_DIR}/scripts/db-migrate.sh"
pending_json="$(node "${ROOT_DIR}/scripts/migration-status.mjs" "${status_args[@]}" --json --quiet 2>/dev/null || true)"
for version in $(node -e 'const r=JSON.parse(process.argv[1]||"{}");for(const v of r.pending||[])console.log(v)' "${pending_json}"); do
  for file in "${ROOT_DIR}"/supabase/migrations/"${version}"_*.sql; do
    [[ -f "${file}" ]] || continue
    if runbook="$(sh "${wrapper}" is-window "${file}")"; then
      echo "[prod-migrate] ✗ $(basename "${file}") is a window migration (stop-the-world); it is applied inside its runbook's window${runbook:+: ${runbook}}, never here."
      echo "[prod-migrate]   Run the window (yarn db:migrate --window <file> for the local stack), then run this again. Nothing applied."
      exit 3
    fi
  done
done

if [[ "${target}" == "local" ]]; then
  # The local stack goes through the wrapper: one transaction per file,
  # recorded under the file's own version, and the stack proven to be the
  # one the runtime names before anything is written.
  runtime_url="$(node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --print-supabase-url 2>/dev/null || true)"
  runtime_url="${runtime_url//$'\n'/}"
  if [[ -z "${runtime_url}" ]]; then
    echo "[prod-migrate] ✗ could not resolve the runtime SUPABASE_URL; not applying on a guess."
    exit 1
  fi
  echo "[prod-migrate] Applying local migrations (yarn db:migrate:pending, for ${runtime_url})..."
  set +e
  sh "${wrapper}" pending --for "${runtime_url}"
  wrapper_code=$?
  set -e
  if [[ "${wrapper_code}" -ne 0 ]]; then
    echo "[prod-migrate] ✗ the wrapper exited ${wrapper_code}; see above. Nothing further applied."
    exit "${wrapper_code}"
  fi
else
  echo "[prod-migrate] Applying ${target} migrations (supabase db push --${target})..."
  supabase db push "--${target}" --workdir "${ROOT_DIR}"
fi

echo "[prod-migrate] Re-checking migration status..."
node "${ROOT_DIR}/scripts/migration-status.mjs" --workdir "${ROOT_DIR}" --target "${target}"
echo "[prod-migrate] ✅ ${target} migrations are up to date."
