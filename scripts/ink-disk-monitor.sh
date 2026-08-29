#!/usr/bin/env bash
#
# ink-disk-monitor.sh — disk pressure checker for the alert webhook.
#
# Written on 2026-08-24, after the Docker filesystem filled and took down
# inkwell, inkread and inktrade together.
#
# WHY THIS IS A SHELL SCRIPT AND NOT AN AGENT OR A SCHEDULED REMINDER
#
#   When the box is out of disk, the LLM path is the first thing to fail:
#   sessions do not spawn and triggers die, so the agent that would raise the
#   alarm is the thing that is broken. A scheduled reminder is worse still --
#   it is dispatched by the inkwell server, which is one of the processes the
#   outage kills. The monitor must be downstream of nothing.
#
#   So: cron/launchd -> this script -> one HTTP POST. No node, no model, no
#   session, no dependency on inkwell being alive to decide that inkwell is
#   not alive. If the POST to inkwell fails, it falls back to the Telegram Bot
#   API directly, because an alarm routed through the machinery it is
#   reporting on is not an alarm.
#
# CONFIGURATION  (env, or ~/.ink/monitor.env which is sourced if present)
#
#   INK_ALERT_URL        default http://localhost:3001/api/alerts
#   INK_ALERT_TOKEN      shared secret; matches ALERT_INGEST_TOKEN on the server
#   INK_CRITICAL_GB      default 4    — wake him regardless of hour
#   INK_WARNING_GB       default 10
#   INK_MONITOR_INTERVAL default 300  — the cadence promised to the server, so
#                                       silence past it is itself alertable
#   TELEGRAM_BOT_TOKEN   fallback delivery when inkwell cannot be reached
#   TELEGRAM_CHAT_ID     fallback recipient
#   INK_DEADMAN_URL      optional external dead-man's-switch to ping on success
#                        (healthchecks.io / Dead Man's Snitch shape). This is
#                        the only observer that survives the host dying, since
#                        a local watcher dies with what it watches.
#
# INSTALL (macOS, every 5 minutes)
#
#   crontab -e, then:
#     */5 * * * * /path/to/scripts/ink-disk-monitor.sh >> ~/.ink/logs/disk-monitor.log 2>&1
#
# EXIT CODES
#   0 healthy · 1 warning raised · 2 critical raised · 3 could not report
#
# Deliberately NOT `set -e`: a monitor that aborts on the first failed check
# reports nothing about the checks it never reached. Failures are collected
# and reported, not fatal.
set -uo pipefail

CONFIG_FILE="${INK_MONITOR_CONFIG:-$HOME/.ink/monitor.env}"
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"

INK_ALERT_URL="${INK_ALERT_URL:-http://localhost:3001/api/alerts}"
INK_ALERT_TOKEN="${INK_ALERT_TOKEN:-}"
INK_CRITICAL_GB="${INK_CRITICAL_GB:-4}"
INK_WARNING_GB="${INK_WARNING_GB:-10}"
INK_MONITOR_INTERVAL="${INK_MONITOR_INTERVAL:-300}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
INK_DEADMAN_URL="${INK_DEADMAN_URL:-}"
SOURCE="disk-monitor"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# macOS ships no `timeout` (it is gtimeout from coreutils, if installed at
# all). Without this shim the docker check below silently produced empty
# output and reported a perfectly healthy daemon as unreachable -- a false
# alarm, which is the one failure mode that reliably teaches people to ignore
# a monitor. Writes stdout to $2 so callers can read it after the wait.
run_with_timeout() {
  local secs="$1" outfile="$2"
  shift 2
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@" >"$outfile" 2>/dev/null
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@" >"$outfile" 2>/dev/null
    return $?
  fi
  # Portable fallback: background the command and reap it if it overruns.
  "$@" >"$outfile" 2>/dev/null &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$secs" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    return 124
  fi
  wait "$pid"
}

json_escape() {
  # No jq dependency: a monitor should not fail because a helper is missing.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}' |
    sed -e 's/\\n$//'
}

# ── Fallback delivery ─────────────────────────────────────────────────────
# Used only when inkwell cannot be reached. Straight to Telegram's API, so
# nothing in this path touches the infrastructure being reported on.
notify_direct() {
  local text="$1"
  if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
    log "FALLBACK UNAVAILABLE: inkwell unreachable and no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configured"
    return 1
  fi
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" 2>/dev/null)
  if [ "$code" = "200" ]; then
    log "fallback delivered via telegram direct"
    return 0
  fi
  log "FALLBACK FAILED: telegram returned $code"
  return 1
}

# ── Fallback rate limiting ────────────────────────────────────────────────
#
# The direct path deliberately bypasses inkwell, which also means it bypasses
# the dedupe and cooldown that live in the database. On a five-minute cron an
# unchanged condition would send a direct Telegram message every five minutes
# — 288 a day, exactly the flood the DB cooldown exists to prevent, arriving
# by the one route designed to work when everything else is broken (PR #539,
# Lumen). So the fallback carries its own per-condition cooldown.
#
# Keyed per dedupe key, not globally: two distinct problems during one outage
# should both get through. Losing the state directory only costs extra
# notifications, which is the right direction to fail for an alerting path.
FALLBACK_STATE_DIR="${INK_FALLBACK_STATE_DIR:-$HOME/.ink/runtime/alert-fallback}"
FALLBACK_NOTIFY_INTERVAL="${INK_FALLBACK_NOTIFY_INTERVAL:-3600}"

# Flatten the key for use as a filename: dedupe keys contain ':' and '/'.
fallback_state_path() {
  printf '%s/%s' "$FALLBACK_STATE_DIR" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
}

# Returns 0 when this condition is allowed to notify directly again.
# Checking and stamping are separate so a failed send does not consume the
# window — the same shape note_unreachable already uses. Otherwise a Telegram
# outage during an inkwell outage would burn the cooldown on a message that
# was never delivered, and silence the one path left.
fallback_cooldown_due() {
  local now last state
  state=$(fallback_state_path "$1")
  now=$(date +%s)
  last=0
  [ -f "$state" ] && last=$(cat "$state" 2>/dev/null || echo 0)
  case "$last" in *[!0-9]* | '') last=0 ;; esac
  [ $((now - last)) -ge "$FALLBACK_NOTIFY_INTERVAL" ]
}

fallback_cooldown_stamp() {
  local state
  state=$(fallback_state_path "$1")
  mkdir -p "$FALLBACK_STATE_DIR" 2>/dev/null
  printf '%s' "$(date +%s)" >"$state" 2>/dev/null
}

# A condition that resolves should be able to alarm again immediately if it
# recurs, rather than waiting out a cooldown from the previous incident.
fallback_cooldown_clear() {
  rm -f "$(fallback_state_path "$1")" 2>/dev/null
}

# ── Primary delivery ──────────────────────────────────────────────────────
post_alert() {
  local severity="$1" title="$2" detail="$3" dedupe="$4" metrics="$5" status="${6:-alerting}"
  local body code response_file

  body=$(cat <<JSON
{"source":"$SOURCE","severity":"$severity","status":"$status",
 "title":"$(json_escape "$title")","detail":"$(json_escape "$detail")",
 "dedupeKey":"$dedupe","metrics":$metrics,
 "notifyAgents":["myra","wren"]}
JSON
)

  response_file="/tmp/ink-alert-response.$$"
  code=$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 20 \
    -X POST "$INK_ALERT_URL" \
    -H 'content-type: application/json' \
    -H "x-ink-alert-token: ${INK_ALERT_TOKEN}" \
    -d "$body" 2>/dev/null)
  local curl_rc=$?

  local response=''
  [ -f "$response_file" ] && response=$(cat "$response_file" 2>/dev/null)
  rm -f "$response_file"

  if [ $curl_rc -ne 0 ] || [ -z "$code" ] || [ "${code:0:1}" != "2" ]; then
    log "inkwell ingest failed (curl rc=$curl_rc http=$code) — falling back"
    # Only escalate to the human directly for real problems; a failed 'ok'
    # post is for the dead-man's switch to notice, not for a 3am message.
    if [ "$status" = "alerting" ] && fallback_cooldown_due "$dedupe"; then
      if notify_direct "🚨 ${title}

${detail}

(Delivered directly — the inkwell alert endpoint at ${INK_ALERT_URL} could not be reached, which may itself be the problem.)"; then
        fallback_cooldown_stamp "$dedupe"
      fi
    fi
    return 1
  fi

  # A 2xx means inkwell RECORDED the alert, not that anyone was told. The
  # response carries notified:false when every sink failed — and this script
  # used to discard the body, so the one signal that says "your alarm went
  # nowhere" was thrown away and the fallback never fired for it. An accepted
  # alert that reached no one is exactly the case the direct path is for.
  #
  # Both halves of the condition matter. status:"deduped" ALSO reports
  # notified:false, but that is the cooldown working — a correctly suppressed
  # repeat, not a failed delivery. Keying on notified alone would send a direct
  # Telegram for every deduped repeat and rebuild the 288-a-day flood out of
  # the very check meant to catch delivery failure. Only "raised" means
  # inkwell tried.
  if [ "$status" = "alerting" ] &&
    printf '%s' "$response" | grep -q '"status"[[:space:]]*:[[:space:]]*"raised"' &&
    printf '%s' "$response" | grep -q '"notified"[[:space:]]*:[[:space:]]*false'; then
    log "inkwell accepted the alert but delivered it nowhere (notified:false)"
    if fallback_cooldown_due "$dedupe"; then
      if notify_direct "🚨 ${title}

${detail}

(Delivered directly — inkwell recorded this alert but every delivery channel failed.)"; then
        fallback_cooldown_stamp "$dedupe"
      fi
    fi
    return 1
  fi

  # Recovered: let a recurrence alarm directly without waiting out a cooldown
  # inherited from the incident that just closed.
  [ "$status" = "ok" ] && fallback_cooldown_clear "$dedupe"

  log "reported: $severity $dedupe (http $code)"
  return 0
}

check_in() {
  curl -sS -o /dev/null --max-time 15 -X POST "${INK_ALERT_URL}/checkin" \
    -H 'content-type: application/json' \
    -H "x-ink-alert-token: ${INK_ALERT_TOKEN}" \
    -d "{\"source\":\"$SOURCE\",\"expectedIntervalSeconds\":$INK_MONITOR_INTERVAL,\"detail\":\"$1\"}" \
    2>/dev/null
}

# ── "I ran but could not report" ──────────────────────────────────────────
#
# The blind spot worth naming: if inkwell is unreachable, the disk may be
# perfectly healthy and yet nobody can be told anything -- and from the
# inside, no alerts and a broken pipe look identical. So an unreachable
# ingest endpoint is itself an outage, reported directly.
#
# Rate-limited via a state file so a long inkwell outage produces one message
# an hour rather than one every five minutes. Losing the state file only
# costs an extra notification, which is the right direction to fail.
UNREACHABLE_STATE="${INK_MONITOR_STATE:-$HOME/.ink/runtime/disk-monitor-unreachable}"
UNREACHABLE_NOTIFY_INTERVAL="${INK_UNREACHABLE_NOTIFY_INTERVAL:-3600}"

note_unreachable() {
  local now last
  now=$(date +%s)
  last=0
  [ -f "$UNREACHABLE_STATE" ] && last=$(cat "$UNREACHABLE_STATE" 2>/dev/null || echo 0)
  case "$last" in *[!0-9]* | '') last=0 ;; esac

  if [ $((now - last)) -ge "$UNREACHABLE_NOTIFY_INTERVAL" ]; then
    if notify_direct "⚠️ Alert pipeline is blind

The disk monitor ran but could not reach the inkwell alert endpoint at ${INK_ALERT_URL}.

Checks are still running locally; nothing can be recorded or routed to the SBs until inkwell is back. Silence from here is not evidence of health."; then
      mkdir -p "$(dirname "$UNREACHABLE_STATE")" 2>/dev/null
      printf '%s' "$now" >"$UNREACHABLE_STATE" 2>/dev/null
    fi
  fi
}

note_reachable() { rm -f "$UNREACHABLE_STATE" 2>/dev/null; }

ping_deadman() {
  # Emitting on success only helps if something notices the absence, and that
  # observer cannot be us -- if this host is what died, nothing local is left
  # to notice the missing ping.
  [ -n "$INK_DEADMAN_URL" ] && curl -sS -o /dev/null --max-time 10 "$INK_DEADMAN_URL" 2>/dev/null
}

# ── Checks ────────────────────────────────────────────────────────────────

exit_code=0
reported_ok=0

# 1. Host data volume. On macOS the Docker disk image lives here, so this is
#    the binding constraint for the failure that motivated the script.
free_gb=$(df -g /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $4}')
used_pct=$(df -g /System/Volumes/Data 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')

if [ -z "$free_gb" ]; then
  log "could not read df for /System/Volumes/Data"
  post_alert "warning" "Disk check failed" \
    "df returned nothing for /System/Volumes/Data — the monitor cannot see the disk." \
    "disk-check-failed" '{}' || exit_code=3
else
  metrics="{\"freeGb\":$free_gb,\"usedPct\":${used_pct:-0}}"
  if [ "$free_gb" -lt "$INK_CRITICAL_GB" ]; then
    log "CRITICAL: ${free_gb}GB free"
    post_alert "critical" "Disk critically low: ${free_gb}GB free" \
      "Only ${free_gb}GB free on /System/Volumes/Data (${used_pct}% used). Below the ${INK_CRITICAL_GB}GB wake-regardless threshold. At zero, inkwell, inkread and inktrade all stop." \
      "disk-free-low" "$metrics" || exit_code=3
    [ $exit_code -eq 0 ] && exit_code=2
  elif [ "$free_gb" -lt "$INK_WARNING_GB" ]; then
    log "WARNING: ${free_gb}GB free"
    post_alert "warning" "Disk low: ${free_gb}GB free" \
      "${free_gb}GB free on /System/Volumes/Data (${used_pct}% used). Critical at ${INK_CRITICAL_GB}GB." \
      "disk-free-low" "$metrics" || exit_code=3
    [ $exit_code -eq 0 ] && exit_code=1
  else
    log "ok: ${free_gb}GB free"
    post_alert "info" "Disk recovered" "${free_gb}GB free." "disk-free-low" "$metrics" "ok" &&
      reported_ok=1
  fi
fi

# 2. Docker daemon. Its reclaimable space is advisory; its unreachability is
#    not — that is how the last outage announced itself.
if command -v docker >/dev/null 2>&1; then
  docker_out="/tmp/ink-docker-df.$$"
  run_with_timeout 20 "$docker_out" docker system df \
    --format '{{.Type}} {{.Size}} {{.Reclaimable}}'
  docker_df=$(cat "$docker_out" 2>/dev/null)
  rm -f "$docker_out"
  if [ -z "$docker_df" ]; then
    log "docker unreachable"
    post_alert "warning" "Docker daemon not responding" \
      "\`docker system df\` returned nothing or timed out. The daemon may be wedged or out of space." \
      "docker-unreachable" '{}' || exit_code=3
    [ $exit_code -eq 0 ] && exit_code=1
  else
    log "docker ok: $(printf '%s' "$docker_df" | tr '\n' ';')"
    post_alert "info" "Docker responding" "Daemon reachable." "docker-unreachable" '{}' "ok" >/dev/null
  fi
fi

# 3. Liveness. Always last, and always sent: this is the ping whose ABSENCE is
#    the signal. A checker that only speaks when something is wrong is
#    indistinguishable from a checker that has died.
if check_in "free=${free_gb:-unknown}GB"; then
  note_reachable
else
  log "check-in failed — inkwell unreachable"
  note_unreachable
  exit_code=3
fi

# The dead-man's switch means "this script ran", so it is pinged even when
# inkwell is unreachable -- the two observers answer different questions and
# conflating them would hide a live checker behind a dead server.
ping_deadman

exit $exit_code
