#!/usr/bin/env bash
# The isolated integration stack's API URL, proven exactly — not a substring.
#
# The harness refuses to run unless SUPABASE_URL is precisely the loopback
# endpoint on the port it reserved: scheme http, host 127.0.0.1, that port,
# and nothing else — no credentials, path, query or fragment. A substring
# check let "https://foreign.invalid:55421" and
# "http://127.0.0.1:54321/#:55421" through (Lumen, #623). Sourced by
# scripts/test-integration-db-local.sh; testable on its own.
#
#   assert_isolated_supabase_url "$SUPABASE_URL" "$API_PORT"   # exit 0 or 1
assert_isolated_supabase_url() {
  local url="$1"
  local port="$2"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "[integration-db] Refusing to run: API port '${port}' is not a number." >&2
    return 1
  fi
  if [[ "$url" != "http://127.0.0.1:${port}" ]]; then
    echo "[integration-db] Refusing to run: SUPABASE_URL='${url}' is not the isolated stack (expected exactly http://127.0.0.1:${port})." >&2
    return 1
  fi
  return 0
}
