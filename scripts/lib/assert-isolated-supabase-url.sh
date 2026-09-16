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
# The refusal names the endpoint without reprinting the value it rejected. A
# URL is a credential-bearing shape — userinfo before the @, a key in the
# query — and the diagnostic runs on a failure path, into a CI log. Report
# scheme, host and port, say which components were dropped, and stop.

# scheme://host:port of a URL, with userinfo, path, query and fragment
# removed and named rather than printed. Anything unparseable reduces to
# "<unparseable>": the fallback never echoes the input.
redact_url() {
  local url="$1"
  local rest scheme hostport dropped=()

  if [[ "$url" != *://* ]]; then
    echo "<unparseable>"
    return 0
  fi

  scheme="${url%%://*}"
  rest="${url#*://}"

  # Order matters: strip the fragment first — "#:55421" would otherwise be
  # read as part of the authority and a foreign host would print as loopback.
  if [[ "$rest" == *"#"* ]]; then
    rest="${rest%%#*}"
    dropped+=("fragment")
  fi
  if [[ "$rest" == *"?"* ]]; then
    rest="${rest%%\?*}"
    dropped+=("query")
  fi
  if [[ "$rest" == *"@"* ]]; then
    rest="${rest#*@}"
    dropped+=("credentials")
  fi
  if [[ "$rest" == *"/"* ]]; then
    local path="${rest#*/}"
    rest="${rest%%/*}"
    [[ -n "$path" ]] && dropped+=("path")
  fi

  hostport="$rest"
  [[ -z "$scheme" || -z "$hostport" ]] && {
    echo "<unparseable>"
    return 0
  }

  if ((${#dropped[@]} > 0)); then
    local list
    list="$(
      IFS=,
      echo "${dropped[*]}"
    )"
    echo "${scheme}://${hostport} (${list//,/, } removed)"
  else
    echo "${scheme}://${hostport}"
  fi
}

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
    echo "[integration-db]   got (redacted):   $(redact_url "${url}")" >&2
    return 1
  fi
  return 0
}
