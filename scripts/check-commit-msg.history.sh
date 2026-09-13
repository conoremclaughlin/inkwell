#!/bin/sh
# Check the guard against real history rather than fixtures.
#
# Two questions that synthetic tests cannot answer:
#
#   1. Does it block the messages that actually leaked?
#   2. Does it stay quiet on everything else we have ever committed?
#
# Both are answered by reading git objects. Nothing is copied into a tracked
# file, so no credential value enters the repository a second time.
#
# THE OUTPUT INVARIANT: this script prints SHAs, exit codes and counts. It never
# prints message content, in any branch, including the failure branches. That is
# not a nicety -- every commit this script names is one the scanner FLAGGED, so
# the one case where it is tempting to show context is precisely the case where
# the context may be a live credential. An earlier revision printed the first 60
# characters of a flagged commit's subject, which disclosed the whole of a
# synthetic canary whose secret was in the subject line. A credential pasted by a
# shell substitution lands wherever the cursor was, and that includes line one.
# If you need to see what was flagged, look it up yourself with the SHA.
#
# scripts/check-commit-msg.test.sh pins this with a synthetic local history whose
# subject IS an assignment, and fails if any of it reaches the output.
#
# This is deliberately NOT part of the CI suite: it depends on local history
# that a shallow CI clone does not have, and the SHAs are only meaningful in
# this repository. scripts/check-commit-msg.test.sh is the portable tier.
#
# Usage:  sh scripts/check-commit-msg.history.sh [sweep-depth]

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
guard="$root/scripts/check-commit-msg.sh"
depth=${1:-1500}

# The three commits whose messages swallowed a shell substitution. Referenced by
# SHA, never by content.
LEAKS="3909d094 0bdefa40 0a7727f2"

tmp=$(mktemp "${TMPDIR:-/tmp}/check-commit-msg-history.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT INT TERM

fail=0

echo "KNOWN LEAKS (must all be blocked)"
for sha in $LEAKS; do
  if ! git -C "$root" log -1 --format=%B "$sha" > "$tmp" 2>/dev/null; then
    echo "  SKIP $sha — not present in this clone"
    continue
  fi
  sh "$guard" "$tmp" >/dev/null 2>&1
  rc=$?
  lines=$(grep -cE '^[A-Z][A-Z0-9_]{3,}=' "$tmp")
  if [ "$rc" -eq 1 ]; then
    echo "  ok   $sha blocked (assignment lines: $lines)"
  else
    echo "  FAIL $sha NOT blocked (exit $rc, assignment lines: $lines)"
    fail=$((fail + 1))
  fi
done

# 0bdefa40 carries only two assignment lines, which is under the dump
# threshold -- it is caught by the named-variable arm alone. That is the
# evidence for keeping both arms; either one on its own misses a real leak.

echo "FALSE POSITIVES (sweep of the last $depth commits on main, must be zero)"
swept=0
flagged=0
for sha in $(git -C "$root" rev-list origin/main -n "$depth" 2>/dev/null); do
  git -C "$root" log -1 --format=%B "$sha" > "$tmp"
  if ! sh "$guard" "$tmp" >/dev/null 2>&1; then
    flagged=$((flagged + 1))
    # SHA only. See the output invariant at the top of this file: a flagged
    # commit is the last one whose text should be echoed anywhere.
    echo "  FAIL $sha flagged (content withheld; inspect it yourself if you must)"
  fi
  swept=$((swept + 1))
done

if [ "$swept" -eq 0 ]; then
  echo "  SKIP no origin/main in this clone — sweep did not run"
elif [ "$flagged" -eq 0 ]; then
  echo "  ok   swept $swept, flagged 0"
else
  echo "  FAIL swept $swept, flagged $flagged"
  fail=$((fail + 1))
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "history check passed"
  exit 0
fi
echo "history check FAILED ($fail)"
exit 1
