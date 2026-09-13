#!/bin/sh
# Pre-push replay: print every commit message about to leave the machine, run
# the commit-message credential guard over each one, and run the staged-file
# guard over each commit's files. Refuse the push if anything trips.
#
# Why this exists when commit-msg and pre-commit already run: those two see a
# commit as it is created, and only if hooks were active on that checkout at
# the time. A commit made with --no-verify, on a worktree whose hooksPath
# predates the guards, or rebased/amended from an older one, reaches the push
# unchecked. The push is the point of no return, so it gets its own gate.
#
# The printing is not decoration. The rule is that every commit message is
# read back before it is pushed, and this is the reading. The output is the
# messages themselves, in order, oldest first — but each one is SCANNED
# BEFORE IT IS PRINTED, and a message the guard refuses is withheld. A raw
# `git log` read-back would write an unscanned message, secret and all, into
# whatever captures the terminal (a session transcript, a CI log). This never
# does.
#
# Usage, as the hook: invoked by git as pre-push. Arguments: remote name,
# remote URL. Stdin: one line per ref being pushed —
#     <local ref> <local sha> <remote ref> <remote sha>
# A remote sha of all zeros means the ref is new on the remote; a local sha of
# all zeros means a delete, which pushes nothing and is not checked.
#
# Usage, by hand:  scripts/check-push.sh --preview [<base>]
# Replays <base>..HEAD (default origin/main) exactly as the hook would, without
# pushing. This is the read-back to run before `git push`.
#
# Exit 0 to allow, 1 to refuse, 2 when a guard could not run (refused).

set -u

here=$(cd "$(dirname "$0")" && pwd) || exit 2
msg_guard="$here/check-commit-msg.sh"
file_guard="$here/check-staged-files.sh"
for g in "$msg_guard" "$file_guard"; do
  if [ ! -f "$g" ] || [ ! -r "$g" ]; then
    echo "" >&2
    echo "Push blocked: the pre-push replay cannot read its guard at" >&2
    echo "   $g" >&2
    echo "   Nothing was checked, so nothing is pushed. Repair the checkout that" >&2
    echo "   owns core.hooksPath." >&2
    echo "" >&2
    exit 2
  fi
done

preview=0
base=''
case "${1:-}" in
  --preview)
    preview=1
    base=${2:-origin/main}
    ;;
esac

zeros=0000000000000000000000000000000000000000
tmp=$(mktemp "${TMPDIR:-/tmp}/check-push.XXXXXX") || exit 2
report=$(mktemp "${TMPDIR:-/tmp}/check-push-report.XXXXXX") || { rm -f "$tmp"; exit 2; }
trap 'rm -f "$tmp" "$report"' EXIT INT TERM

failed=0
total=0

# One commit: scan the message, print it only if clean, scan the files.
# Globals `failed` and `total` accumulate; callers must not run this in a
# subshell or the counts are lost.
replay_commit() {
  sha=$1
  total=$((total + 1))
  short=$(git rev-parse --short "$sha")

  if ! git log -1 --format=%B "$sha" > "$tmp"; then
    echo "Push blocked: could not read the message of $short; refusing rather than pushing unchecked." >&2
    exit 2
  fi

  # Scan BEFORE printing. A message the guard refuses is exactly the message
  # that carries a credential, and printing it would write the value to the
  # terminal and to whatever captures it. Refused messages are withheld and
  # only the guard's value-free report is shown; clean messages are printed
  # in full, which is the read-back.
  sh "$msg_guard" "$tmp" > "$report" 2>&1
  rc=$?
  echo ""
  echo "--- $short"
  if [ "$rc" -eq 0 ]; then
    sed 's/^/    /' "$tmp"
  else
    failed=1
    echo "    (message withheld: refused by the credential guard, exit $rc)"
    sed 's/^/    /' "$report"
    echo "   ^ commit $short: message refused by the credential guard (exit $rc)."
  fi

  sh "$file_guard" --commit "$sha"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    failed=1
    echo "   ^ commit $short: files refused by the staged-file guard (exit $rc)."
  fi
}

if [ "$preview" -eq 1 ]; then
  range=$(git rev-list --reverse "$base..HEAD" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "Read-back failed: could not list $base..HEAD (git exited $rc). Is '$base' a ref in this repository?" >&2
    exit 2
  fi
  if [ -n "$range" ]; then
    echo ""
    echo "=== $base..HEAD: commit messages that would be pushed (read them) ==="
    for sha in $range; do
      replay_commit "$sha"
    done
  fi
else
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "${local_sha:-}" ] && continue
    [ "$local_sha" = "$zeros" ] && continue   # delete: nothing leaves the machine

    if [ "$remote_sha" = "$zeros" ]; then
      # New ref on the remote: everything reachable from it that no remote
      # already has. Wider than "since origin/main" on purpose — a branch cut
      # from another branch still pushes those commits for the first time.
      range=$(git rev-list --reverse "$local_sha" --not --remotes 2>/dev/null)
      rc=$?
    else
      range=$(git rev-list --reverse "$remote_sha..$local_sha" 2>/dev/null)
      rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      echo "Push blocked: could not list the commits for $local_ref (git exited $rc); refusing rather than pushing unchecked." >&2
      exit 2
    fi
    [ -z "$range" ] && continue

    echo ""
    echo "=== $local_ref -> $remote_ref: commit messages about to be pushed (read them) ==="
    for sha in $range; do
      replay_commit "$sha"
    done
  done
fi

if [ "$total" -eq 0 ]; then
  [ "$preview" -eq 1 ] && echo "Nothing to push: $base..HEAD is empty."
  exit 0
fi

echo ""
if [ "$failed" -ne 0 ]; then
  if [ "$preview" -eq 1 ]; then
    echo "Read-back: $total commit(s) checked, at least one refused. Do not push this."
  else
    echo "Push blocked: $total commit(s) checked, at least one refused. Nothing was pushed."
  fi
  echo "   Fix the commit locally (amend or rewrite), then try again. Do not --no-verify"
  echo "   past this: a pushed credential is public the moment it lands."
  echo ""
  exit 1
fi

echo "$total commit message(s) printed above and scanned clean. Passing the scan means"
echo "nothing matched, not that the messages are clean — read them."
echo ""
exit 0
