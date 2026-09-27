#!/usr/bin/env bash
# Turn off Kong's upstream keepalive in the isolated stack's gateway.
#
# The "An invalid response was received from the upstream server" failures in
# the Integration DB job are Kong reusing a pooled connection to PostgREST at
# the moment PostgREST closes it. Kong 2.8.1 keeps idle upstream connections
# for up to 60 s (upstream_keepalive_idle_timeout); PostgREST closes an idle
# connection after 32-60 s (measured on v14.7 and v13.0.5, 2026-09-27), so a
# pooled connection can be closed under Kong's feet. nginx retries an
# idempotent request on a fresh connection, and a GET never surfaces, but it
# will not resend a POST or PATCH, so those come back 502. Every one of the 13
# captured 502s from 2026-09-22 to 2026-09-27 was a POST or a PATCH; the one
# run that also logged a GET hitting a closed connection (ca7213d5) did not
# fail on it. Evidence and population: Inkwell task 388ae17e.
#
# With pool size 0 Kong opens a fresh upstream connection per request, so no
# pooled connection exists to be closed. A lower idle timeout would also work,
# but only while PostgREST's idle floor stays above it; pool size 0 does not
# depend on the upstream's timing. The cost is one TCP connect per request
# inside the stack's network, and one TIME_WAIT socket per request on Kong's
# side: a full pass is ~4,900 requests in ~30 s, well inside the ephemeral
# range's ~470/s ceiling at a 60 s TIME_WAIT.
#
# The Supabase CLI sets Kong's environment and exposes no keepalive setting,
# and PostgREST has no server timeout option, so this reconfigures the running
# container: `kong reload` with the setting in the environment, and the CLI's
# own nginx template, since a reload without it regenerates nginx.conf from
# Kong's default template. The reload is graceful. It has to be repeated after
# every `supabase start`, which recreates the container; on a warm stack where
# it already holds, nothing is reloaded.
#
#   disable_kong_upstream_keepalive "supabase_kong_${PROJECT_ID}"   # exit 0 or 1
#
# Returns 1, with a reason, when it could not confirm the setting; the caller
# decides whether that stops the run. Kong's own output is never printed: a
# reload error can quote the declarative config, which carries the stack's keys.

KONG_NGINX_TEMPLATE="${KONG_NGINX_TEMPLATE:-/home/kong/custom_nginx.template}"

kong_upstream_keepalive_pool_size() {
  docker exec "$1" sed -n 's/^upstream_keepalive_pool_size = //p' /usr/local/kong/.kong_env 2>/dev/null
}

disable_kong_upstream_keepalive() {
  local container="$1"
  local before after
  # Only ever the disposable integration stack's gateway. The harness's parent
  # already refuses any other project ID; this is the one step that
  # reconfigures a running container, and the shared stack's Kong is a single
  # name away, so it checks again rather than trusting its caller.
  if [[ ! "$container" =~ ^supabase_kong_(ink|pcp)-integration(-[a-zA-Z0-9_-]+)?$ ]]; then
    echo "[integration-db] Not reconfiguring ${container}: not an integration stack's Kong." >&2
    return 1
  fi
  if ! before="$(kong_upstream_keepalive_pool_size "$container")" || [[ -z "$before" ]]; then
    echo "[integration-db] Could not read Kong's upstream keepalive setting from ${container}." >&2
    return 1
  fi
  if [[ "$before" == "0" ]]; then
    echo "[integration-db] Kong upstream keepalive already off (pool size 0)."
    return 0
  fi
  if ! docker exec "$container" test -r "$KONG_NGINX_TEMPLATE" 2>/dev/null; then
    echo "[integration-db] Kong's nginx template ${KONG_NGINX_TEMPLATE} is missing; not reloading." >&2
    return 1
  fi
  if ! docker exec -e KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0 "$container" \
    kong reload --nginx-conf "$KONG_NGINX_TEMPLATE" >/dev/null 2>&1; then
    echo "[integration-db] kong reload failed; upstream keepalive is still on (pool size ${before})." >&2
    return 1
  fi
  after="$(kong_upstream_keepalive_pool_size "$container")"
  if [[ "$after" != "0" ]]; then
    echo "[integration-db] Kong reloaded, but upstream keepalive pool size reads '${after}', not 0." >&2
    return 1
  fi
  echo "[integration-db] Kong upstream keepalive off (pool size ${before} -> 0)."
  return 0
}
