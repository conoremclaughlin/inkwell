#!/bin/sh
# Refuse a commit (or a push) that carries a file no commit should ever carry.
#
# Two arms, both value-free in what they print:
#
#   NAMES   — files that are credentials by construction: dotenv files that are
#             not examples, private keys, the ink identity/auth files, MCP and
#             Claude local settings, git and postgres credential files. These
#             are refused on the PATH alone, before anything reads them.
#
#   SHAPES  — vendor token formats (scripts/lib/credential-patterns.sh) inside
#             any text file being committed. Reported as path and line numbers,
#             never the matched bytes.
#
# The commit-msg guard cannot see files and this guard cannot see the message;
# they are two halves. This one exists because `git add .` and `git add -A`
# stage untracked files nobody looked at, and because a credential pasted into
# a source file or a fixture looks like ordinary text in a diff.
#
# Usage:
#   scripts/check-staged-files.sh               scan the index (pre-commit)
#   scripts/check-staged-files.sh --commit SHA  scan the files SHA adds/changes
#                                               against its first parent (pre-push)
#
# Exit codes mirror check-commit-msg.sh: 0 clean, 1 refused, 2 the scan itself
# failed and the operation is refused rather than assumed safe.
#
# Hook: .husky/pre-commit resolves this file relative to ITSELF, not to the
# worktree being committed from — see the note at the top of
# scripts/check-commit-msg.sh for why that distinction is load-bearing on a
# machine with worktrees.

set -u

here=$(cd "$(dirname "$0")" && pwd) || exit 2
patterns="$here/lib/credential-patterns.sh"
if [ ! -f "$patterns" ] || [ ! -r "$patterns" ]; then
  echo "" >&2
  echo "Blocked: the staged-file guard cannot read its pattern library at" >&2
  echo "   $patterns" >&2
  echo "   Nothing was checked, so nothing is allowed through. Repair the checkout" >&2
  echo "   that owns core.hooksPath." >&2
  echo "" >&2
  exit 2
fi
# shellcheck source=lib/credential-patterns.sh
. "$patterns"
case "${shapes:-}" in
  '')
    echo "Blocked: the pattern library loaded but defines no shapes; refusing rather than scanning with nothing." >&2
    exit 2
    ;;
esac

mode=index
commit=''
case "${1:-}" in
  '') ;;
  --commit)
    mode=commit
    commit=${2:-}
    if [ -z "$commit" ]; then
      echo "usage: $0 [--commit SHA]" >&2
      exit 2
    fi
    ;;
  *)
    echo "usage: $0 [--commit SHA]" >&2
    exit 2
    ;;
esac

# The path list. -z would be stricter, but a newline inside a path is something
# git itself refuses to print unquoted, and every consumer below is a plain
# `while read` — so paths are taken one per line, which is what git emits for
# every path we will ever commit here.
if [ "$mode" = index ]; then
  paths=$(git diff --cached --name-only --diff-filter=ACMR)
  rc=$?
else
  # --root so a repository's first commit is diffed against the empty tree
  # rather than against nothing.
  paths=$(git diff-tree --root --no-commit-id --name-only -r --diff-filter=ACMR "$commit")
  rc=$?
fi
if [ "$rc" -ne 0 ]; then
  echo "Blocked: could not list the files to check (git exited $rc); refusing rather than passing an unchecked set." >&2
  exit 2
fi
[ -z "$paths" ] && exit 0

# NAMES. Matched against the full path with a leading slash so both "/.env" and
# "packages/api/.env" are one rule. Order matters only in that the allow list
# for example/template files is consulted first.
forbidden_name() {
  p="/$1"
  base=${p##*/}

  # Allowed regardless of what follows: templates that ship placeholders.
  case "$base" in
    *.example | *.sample | *.template | *.dist) return 1 ;;
  esac

  case "$base" in
    .env | .env.*) return 0 ;;
    *.pem | *.key | *.p12 | *.pfx | *.jks | *.keystore | *.ppk) return 0 ;;
    id_rsa | id_dsa | id_ecdsa | id_ed25519) return 0 ;;
    .netrc | .pgpass | .git-credentials) return 0 ;;
    credentials.json | service-account*.json | client_secret*.json) return 0 ;;
    .mcp.json) return 0 ;;
  esac

  case "$p" in
    */.ink/identity.json | */.ink/auth.json | */.ink/auth/*) return 0 ;;
    */.claude/settings.local.json) return 0 ;;
    */.ssh/*) return 0 ;;
  esac
  return 1
}

# Content for a path in the mode we are running in. Never the working tree:
# the working tree can differ from what is being committed, and the working
# tree is not what leaves the machine.
blob_of() {
  if [ "$mode" = index ]; then
    git show ":$1"
  else
    git show "$commit:$1"
  fi
}

refused=0
scan_failed=0
name_hits=''
shape_hits=''

while IFS= read -r path; do
  [ -z "$path" ] && continue

  if forbidden_name "$path"; then
    refused=1
    name_hits="$name_hits$path
"
    # A forbidden file is refused on its name; its content is not opened.
    continue
  fi

  # SHAPES. Binary files are skipped by grep -I. A blob that cannot be read at
  # all is a failed scan, not a clean one.
  matches=$(blob_of "$path" 2>/dev/null | grep -nIE "$shapes" | cut -d: -f1)
  rc=$?
  # $rc is cut's status; capture grep's separately.
  grep_rc=$(blob_of "$path" 2>/dev/null | grep -qIE "$shapes"; echo $?)
  if [ "$grep_rc" -ge 2 ] || [ "$rc" -ne 0 ]; then
    scan_failed=1
    continue
  fi
  if [ "$grep_rc" -eq 0 ]; then
    refused=1
    lines=$(printf '%s' "$matches" | tr '\n' ',' | sed 's/,$//')
    shape_hits="$shape_hits$path: line(s) $lines
"
  fi
done <<EOF
$paths
EOF

if [ "$scan_failed" -eq 1 ]; then
  echo "" >&2
  echo "Blocked: the credential scan did not complete for at least one file." >&2
  echo "   A scan that errors is not a scan that found nothing, so the operation" >&2
  echo "   is refused. Nothing has been committed or pushed." >&2
  echo "" >&2
  exit 2
fi

if [ "$refused" -eq 1 ]; then
  echo ""
  if [ "$mode" = index ]; then
    echo "Commit blocked: the staged files include something that must never be committed."
  else
    echo "Push blocked: commit $commit carries a file that must never be committed."
  fi
  echo ""
  if [ -n "$name_hits" ]; then
    echo "   Refused by name (credential files are never tracked):"
    printf '%s' "$name_hits" | while IFS= read -r h; do
      [ -n "$h" ] && printf '      %s\n' "$h"
    done
  fi
  if [ -n "$shape_hits" ]; then
    echo "   Vendor token pattern inside the file (values are not printed):"
    printf '%s' "$shape_hits" | while IFS= read -r h; do
      [ -n "$h" ] && printf '      %s\n' "$h"
    done
  fi
  echo ""
  if [ "$mode" = index ]; then
    echo "   Unstage it (git restore --staged <path>) and stage by naming the paths"
    echo "   you mean. git add -A and git add . are how these get in."
    echo "   Nothing has been committed; your index is untouched."
  else
    echo "   The commit was created with hooks bypassed or before the guard existed."
    echo "   Rewrite it locally before pushing; a pushed credential is public."
  fi
  echo ""
  exit 1
fi

exit 0
