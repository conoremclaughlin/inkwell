#!/usr/bin/env bash
#
# setup-docker-log-rotation.sh
#
# Configures ~/.docker/daemon.json with json-file log rotation so local
# Supabase containers don't silently fill your Docker VM disk.
# See docs/setup/docker-log-rotation.md and
# docs/runbooks/supabase-disk-full.md for the full story.

set -euo pipefail

DAEMON_JSON="${HOME}/.docker/daemon.json"
TMP_JSON="$(mktemp -t daemon.json.XXXXXX)"
trap 'rm -f "$TMP_JSON"' EXIT

DESIRED=$(cat <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3",
    "compress": "true"
  }
}
EOF
)

mkdir -p "$(dirname "$DAEMON_JSON")"

if [[ -s "$DAEMON_JSON" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: $DAEMON_JSON already exists and jq is not installed." >&2
    echo "Install jq (brew install jq) or merge the keys manually." >&2
    echo "Desired contents:" >&2
    echo "$DESIRED" >&2
    exit 1
  fi
  # Merge desired keys on top of existing config.
  jq -s '.[0] * .[1]' "$DAEMON_JSON" <(echo "$DESIRED") > "$TMP_JSON"
else
  echo "$DESIRED" > "$TMP_JSON"
fi

mv "$TMP_JSON" "$DAEMON_JSON"
trap - EXIT

echo "Wrote $DAEMON_JSON:"
cat "$DAEMON_JSON"
echo ""
echo "Next steps:"
echo "  1. Restart Docker Desktop so the new logging driver applies."
echo "  2. Restart the Supabase stack to re-create containers with rotation:"
echo "       supabase stop && supabase start"
echo ""
echo "Existing container logs are not rotated retroactively. To reclaim"
echo "space from a runaway log without restarting the container:"
echo "  docker run --rm --privileged -v /:/host alpine \\"
echo "    truncate -s 0 /host/var/lib/docker/containers/<prefix>/<prefix>-json.log"
