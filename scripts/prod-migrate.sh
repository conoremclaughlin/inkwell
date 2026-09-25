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

# ONE listing, validated, used for everything below: the verdict, the pending
# set, and the window scan. A second CLI call could answer differently, and a
# failure of that second call was once swallowed into "no pending files".
set +e
status_json="$(node "${ROOT_DIR}/scripts/migration-status.mjs" "${status_args[@]}" --json 2>/dev/null)"
status_code=$?
set -e

# Read the answer through node, so a listing that is not JSON, or not the
# shape expected, is a refusal rather than a bash surprise. Prints one line:
# "<target> <state> <pending versions...>", or nothing.
read -r target state pending_versions < <(node -e '
  let r;
  try { r = JSON.parse(process.argv[1] || ""); } catch { process.exit(0); }
  const target = r && (r.target === "local" || r.target === "linked") ? r.target : "";
  const state = r && (r.state === "clean" || r.state === "pending" || r.state === "unknown") ? r.state : "";
  const pending = r && Array.isArray(r.pending) && r.pending.every((v) => /^[0-9]{14}$/.test(String(v))) ? r.pending : null;
  if (!target || !state || pending === null) process.exit(0);
  console.log([target, state, ...pending].join(" "));
' "${status_json}" || true)
target="${target:-}"
state="${state:-}"
pending_versions="${pending_versions:-}"

if [[ -z "${target}" || -z "${state}" ]]; then
  echo "[prod-migrate] ✗ the migration listing could not be read (status exit ${status_code}); refusing to apply on an unknown listing."
  exit 2
fi
echo "[prod-migrate] Target: ${target}"

if [[ "${status_code}" -eq 0 && "${state}" == "clean" ]]; then
  echo "[prod-migrate] No pending ${target} migrations."
  exit 0
fi

if [[ "${status_code}" -ne 10 || "${state}" != "pending" || -z "${pending_versions}" ]]; then
  echo "[prod-migrate] ✗ migration status is '${state}' (exit ${status_code}); refusing to apply on an unknown listing."
  exit 2
fi
echo "[prod-migrate] ⚠ pending ${target} migrations: ${pending_versions}"

# A window migration (`-- db-migrate: window <runbook>` in its first ten
# lines) is applied inside its runbook's window, by hand, never by this
# script on either target. The wrapper owns the marker's definition; a file
# it cannot judge (unreadable, missing, ambiguous) is a refusal too.
wrapper="${ROOT_DIR}/scripts/db-migrate.sh"
for version in ${pending_versions}; do
  matches=("${ROOT_DIR}"/supabase/migrations/"${version}"_*.sql)
  if [[ "${#matches[@]}" -ne 1 || ! -f "${matches[0]}" ]]; then
    echo "[prod-migrate] ✗ expected exactly one file for pending version ${version} under supabase/migrations (found ${#matches[@]}); nothing applied."
    exit 2
  fi
  file="${matches[0]}"
  set +e
  runbook="$(sh "${wrapper}" is-window "${file}")"
  window_code=$?
  set -e
  case "${window_code}" in
    0)
      echo "[prod-migrate] ✗ $(basename "${file}") is a window migration (stop-the-world); it is applied inside its runbook's window${runbook:+: ${runbook}}, never here."
      echo "[prod-migrate]   Run the window (yarn db:migrate --window <file> for the local stack), then run this again. Nothing applied."
      exit 3
      ;;
    1) ;;
    *)
      echo "[prod-migrate] ✗ could not judge $(basename "${file}") (is-window exit ${window_code}); nothing applied."
      exit 2
      ;;
  esac
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
  echo "[prod-migrate] Applying local migrations (yarn db:migrate:pending, for $(sh "${wrapper}" safe-origin "${runtime_url}"))..."
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
