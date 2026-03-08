#!/usr/bin/env bash
set -euo pipefail

# Optional local smoke test (NOT CI):
# Verifies that sb chat local tool routing can execute get_inbox via sb runtime
# across configured backends.
#
# Prerequisites:
# - Local PCP API server running (default: http://localhost:3101)
# - Authenticated backend CLIs (claude/codex/gemini)
# - Built CLI in this package (dist/cli.js)
#
# Tunables:
#   SB_SMOKE_AGENT=lumen
#   SB_SMOKE_BACKENDS="claude codex gemini"
#   SB_SMOKE_BIN="node dist/cli.js"
#   SB_SMOKE_TIMEOUT_SECONDS=20
#   SB_SMOKE_DEBUG_FILE=/tmp/sb-chat-smoke-debug.log
#   PCP_SERVER_URL=http://localhost:3101

AGENT="${SB_SMOKE_AGENT:-lumen}"
BACKENDS="${SB_SMOKE_BACKENDS:-claude codex gemini}"
SB_BIN="${SB_SMOKE_BIN:-node dist/cli.js}"
TIMEOUT_SECONDS="${SB_SMOKE_TIMEOUT_SECONDS:-20}"
DEBUG_FILE="${SB_SMOKE_DEBUG_FILE:-/tmp/sb-chat-smoke-debug.log}"
PCP_URL="${PCP_SERVER_URL:-http://localhost:3101}"

if [[ ! -f "dist/cli.js" ]]; then
  echo "dist/cli.js not found. Run: yarn workspace @personal-context/cli build"
  exit 1
fi

prompt_for_backend() {
  local agent="$1"
  cat <<EOF
Emit exactly one fenced pcp-tool block and nothing else:
\`\`\`pcp-tool
{"tool":"get_inbox","args":{"agentId":"${agent}","status":"unread","limit":1}}
\`\`\`
EOF
}

failures=0

echo "Running sb-chat live smoke test"
echo "  agent:    ${AGENT}"
echo "  backends: ${BACKENDS}"
echo "  pcp:      ${PCP_URL}"
echo "  timeout:  ${TIMEOUT_SECONDS}s"
echo "  debug:    ${DEBUG_FILE}"
echo ""

for backend in ${BACKENDS}; do
  if ! command -v "${backend}" >/dev/null 2>&1; then
    echo "SKIP ${backend}: binary not found in PATH"
    continue
  fi

  echo "==> ${backend}"
  prompt="$(prompt_for_backend "${AGENT}")"

  set +e
  output="$(
    PCP_SERVER_URL="${PCP_URL}" \
      SB_DEBUG_FILE="${DEBUG_FILE}" \
      ${SB_BIN} chat \
      -a "${AGENT}" \
      -b "${backend}" \
      --tool-routing local \
      --sb-strict-tools \
      --backend-timeout-seconds "${TIMEOUT_SECONDS}" \
      --sb-debug \
      --non-interactive \
      --message "${prompt}" \
      --poll-seconds 999 \
      --verbose \
      2>&1
  )"
  rc=$?
  set -e

  if [[ ${rc} -ne 0 ]]; then
    echo "FAIL ${backend}: sb chat exited ${rc}"
    echo "${output}" | tail -n 40
    failures=$((failures + 1))
    continue
  fi

  if ! grep -Eq "local tool get_inbox|Local tool error \\(get_inbox\\)|local tool call emitted; see tool results above" <<<"${output}"; then
    echo "FAIL ${backend}: no sb local tool routing marker found"
    echo "${output}" | tail -n 60
    failures=$((failures + 1))
    continue
  fi

  if grep -q "Local tool error (get_inbox)" <<<"${output}"; then
    echo "WARN ${backend}: local tool call was routed but PCP call failed (check PCP_SERVER_URL/auth)"
  fi

  echo "PASS ${backend}"
done

echo ""
if [[ ${failures} -gt 0 ]]; then
  echo "Smoke test failed (${failures} backend(s) failed)."
  exit 1
fi

echo "Smoke test passed."
