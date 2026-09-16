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
#
# The refusal names the endpoint it wanted and prints NO part of the value it
# rejected. A URL is a credential-bearing shape — userinfo before the @, a key
# in the query — and this diagnostic runs on a failure path, into a CI log.
#
# An earlier version printed a sanitised scheme://host:port instead, stripping
# each component in turn. Every round of review found another component that
# reached the output through an ordering the stripper had not anticipated: a
# fragment read as the authority, then a path read as the host once userinfo
# was cut first ("/path@x" printed as host "x"), then the second half of a
# multi-@ userinfo, and a scheme that was never validated at all. Two of those
# printed under the label "(credentials removed)". A sanitiser that must parse
# hostile input correctly to stay safe is the wrong shape for a failure path;
# the endpoint the harness expected is the diagnostic an operator needs, and
# the rejected value is already in their own shell to look at (Lumen, #645).

assert_isolated_supabase_url() {
  local url="$1"
  local port="$2"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "[integration-db] Refusing to run: the API port is not a number." >&2
    return 1
  fi
  if [[ "$url" != "http://127.0.0.1:${port}" ]]; then
    echo "[integration-db] Refusing to run: SUPABASE_URL is not the isolated stack." >&2
    echo "[integration-db]   expected exactly: http://127.0.0.1:${port}" >&2
    echo "[integration-db]   got: not shown — a rejected URL can carry credentials." >&2
    echo "[integration-db]   Inspect SUPABASE_URL in your own shell." >&2
    return 1
  fi
  return 0
}
