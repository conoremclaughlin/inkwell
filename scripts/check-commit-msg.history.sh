#!/bin/sh
# Check the guard against real history rather than fixtures.
#
# Two questions that synthetic tests cannot answer:
#
#   1. Does it block the messages that actually leaked?
#   2. Does it stay quiet on everything else we have ever committed, apart from
#      the handful of commits listed as audited prose below?
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

# Commits the scanner flags that carry no credential: prose about this guard that
# writes an assignment. Each one has been read in full before being listed.
#
# WHY THIS LIST EXISTS AND WHERE IT MAY NOT GO. The guard has no exemptions —
# removing the last two is what the previous round of this PR was about — and
# nothing here changes that. This is the sweep of IMMUTABLE history, a different
# question from whether to accept a new commit: a commit already in main cannot
# be made safe by refusing it, and a sweep that is permanently red is a sweep
# nobody runs. scripts/check-commit-msg.sh must never read this list.
#
# Pinned by FULL SHA, which names one audited byte sequence. A short SHA can
# collide as history grows; a pattern could widen to cover a future leak. The
# classification is applied to a REFUSAL only — see the sweep below, where a scan
# that fails to complete is a failure whether or not the commit is pinned. A pin
# says "I read this message and it holds no credential", which is a claim about
# content and says nothing about a scanner that did not run.
#
# b6dd29db — recorded the guard blocking its own author. Quotes the hazard as
# "JWT_SECRET=<value>" and the prose form that used to pass as "JWT_SECRET=".
# Read in full: placeholder text throughout, no credential.
KNOWN_PROSE="b6dd29db330f66df865d838b8be4fdd3b46e2ff7"

# Locals are named with a prefix because this is sh and everything is global: an
# earlier revision's loop variable was `known`, which is also the sweep's counter,
# so the first classified commit left a SHA where a number belonged and the next
# `known=$((known + 1))` aborted the sweep mid-run.
is_known_prose() {
  prose_full=$(git -C "$root" rev-parse "$1" 2>/dev/null) || return 1
  for prose_pin in $KNOWN_PROSE; do
    [ "$prose_full" = "$prose_pin" ] && return 0
  done
  return 1
}

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

echo "FALSE POSITIVES (sweep of the last $depth commits on main)"
swept=0
flagged=0
known=0
unexpected=0
errors=0
revs=''
skip_reason=''

# "The sweep found nothing" and "the sweep did not run" are different results and
# used to print the same way: rev-list's own failure was discarded with 2>/dev/null
# and an empty list fell through to the SKIP line, which passes. A clone without
# origin/main is a legitimate reason to skip -- this runner is local-only by
# design. rev-list failing on a ref that DOES exist is a broken repository, and
# that is a failure like any other scan that did not complete.
if ! git -C "$root" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  skip_reason="no origin/main in this clone"
else
  revs=$(git -C "$root" rev-list origin/main -n "$depth" 2>/dev/null)
  revs_rc=$?
  if [ "$revs_rc" -ne 0 ]; then
    errors=$((errors + 1))
    echo "  FAIL rev-list over origin/main failed (exit $revs_rc) — the sweep did not run"
    revs=''
  fi
fi

for sha in $revs; do
  swept=$((swept + 1))

  # A message we could not read is not a message we checked.
  if ! git -C "$root" log -1 --format=%B "$sha" > "$tmp" 2>/dev/null; then
    errors=$((errors + 1))
    echo "  FAIL $sha could not be read — not a clean result"
    continue
  fi

  sh "$guard" "$tmp" >/dev/null 2>&1
  rc=$?
  case "$rc" in
    0) ;;
    1)
      flagged=$((flagged + 1))
      if is_known_prose "$sha"; then
        known=$((known + 1))
        echo "  note $sha flagged — classified as known prose (audited; content withheld)"
      else
        unexpected=$((unexpected + 1))
        # SHA only. See the output invariant at the top of this file: a flagged
        # commit is the last one whose text should be echoed anywhere.
        echo "  FAIL $sha flagged (content withheld; inspect it yourself if you must)"
      fi
      ;;
    *)
      # Deliberately outside the classification. A pin records that a message was
      # read and holds no credential; a scanner that did not complete has not
      # read anything, so there is nothing for the pin to speak to. Letting a pin
      # absorb this would turn the list into a way to switch the sweep off for a
      # commit, which is exactly what it must not become.
      errors=$((errors + 1))
      echo "  FAIL $sha scan did not complete (exit $rc) — not a clean result"
      ;;
  esac
done

if [ -n "$skip_reason" ]; then
  echo "  SKIP $skip_reason — sweep did not run"
elif [ "$unexpected" -ne 0 ] || [ "$errors" -ne 0 ]; then
  echo "  FAIL swept $swept, flagged $flagged, unexpected $unexpected, scan errors $errors"
  fail=$((fail + 1))
elif [ "$swept" -eq 0 ]; then
  # origin/main resolved, so there was something to sweep. Zero swept means the
  # loop never ran, and "nothing was checked" must not print as "nothing found".
  echo "  FAIL origin/main resolved but nothing was swept"
  fail=$((fail + 1))
elif [ "$known" -eq 0 ]; then
  echo "  ok   swept $swept, flagged 0"
else
  echo "  ok   swept $swept, flagged $flagged, all known prose ($known), unexpected 0"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "history check passed"
  exit 0
fi
echo "history check FAILED ($fail)"
exit 1
