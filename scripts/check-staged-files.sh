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
#   scripts/check-staged-files.sh --commit SHA  scan what SHA changes against
#                                               its FIRST PARENT (the empty tree
#                                               for a root commit), so a merge
#                                               commit's resolution is scanned
#                                               like any other change (pre-push)
#
# Exit codes mirror check-commit-msg.sh: 0 clean, 1 refused, 2 the scan itself
# could not complete and the operation is refused rather than assumed safe.
#
# Paths are taken NUL-separated (-z) so a filename with a quote, a tab, or a
# non-ASCII byte arrives as bytes rather than as git's C-quoted rendering,
# which `git show` would not resolve. A path containing a newline cannot be
# carried through a line-oriented shell loop losslessly, so it is refused
# (exit 2) rather than misread. Every blob read is checked on its own exit
# status: a read that fails is a scan that did not happen, never a clean file.
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

fail_closed() { # reason...
  echo "" >&2
  if [ "$mode" = index ]; then
    echo "Commit blocked: the staged-file scan did not complete." >&2
  else
    echo "Push blocked: the file scan of commit $commit did not complete." >&2
  fi
  printf '   %s\n' "$@" >&2
  echo "   A scan that errors is not a scan that found nothing, so the operation" >&2
  echo "   is refused. Nothing has been committed or pushed." >&2
  echo "" >&2
  exit 2
}

raw=$(mktemp "${TMPDIR:-/tmp}/check-staged-paths.XXXXXX") || exit 2
list=$(mktemp "${TMPDIR:-/tmp}/check-staged-list.XXXXXX") || { rm -f "$raw"; exit 2; }
blob=$(mktemp "${TMPDIR:-/tmp}/check-staged-blob.XXXXXX") || { rm -f "$raw" "$list"; exit 2; }
trap 'rm -f "$raw" "$list" "$blob"' EXIT INT TERM

# The comparison base for --commit: the first parent, or the empty tree for a
# root commit. `git diff-tree <sha>` alone shows NOTHING for a merge commit,
# which is how a credential file introduced in a merge resolution used to pass.
parent=''
if [ "$mode" = commit ]; then
  parent=$(git rev-parse -q --verify "$commit^1" 2>/dev/null)
  if [ -z "$parent" ]; then
    parent=$(git hash-object -t tree /dev/null) || fail_closed "could not compute the empty tree"
  fi
fi

# The path list, NUL-separated. T (type change) is included: a symlink replaced
# by a regular file has new content that must be scanned.
if [ "$mode" = index ]; then
  git diff --cached --name-only -z --diff-filter=ACMRT > "$raw"
  rc=$?
else
  git diff --name-only -z --diff-filter=ACMRT "$parent" "$commit" > "$raw"
  rc=$?
fi
[ "$rc" -ne 0 ] && fail_closed "could not list the files to check (git exited $rc)"
[ -s "$raw" ] || exit 0

# Convert NUL to newline ONCE, into a file, and check that conversion on its
# own. The count below and the loop further down both read this same file, so
# a conversion that fails cannot leave the loop with an empty feed and a clean
# verdict. (It did, once: the feed was a second tr inside a here-doc, whose
# status nothing looked at.)
tr '\000' '\n' < "$raw" > "$list" || fail_closed "could not convert the staged path list"

# Lossless-ness check: with -z each path ends in one NUL. If a path itself
# contains a newline, the converted list has more lines than there were
# entries, and no line-oriented loop can recover the original path. Each
# count is validated on its own; a count that is empty or non-numeric is a
# failed scan, not a zero.
entries=$(tr -cd '\000' < "$raw" | wc -c | tr -d ' ')
case "$entries" in '' | *[!0-9]*) fail_closed "could not count the staged paths (entries)" ;; esac
lines=$(grep -c '' < "$list")
case "$lines" in '' | *[!0-9]*) fail_closed "could not count the staged paths (lines)" ;; esac
[ "$entries" -ne "$lines" ] && fail_closed "a staged path contains a newline; refusing rather than misreading it"

# NAMES. Matched against the full path with a leading slash so both "/.env" and
# "packages/api/.env" are one rule. The allow list for example/template files
# is consulted first.
forbidden_name() {
  p="/$1"
  base=${p##*/}

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

# The entry's mode in the tree being scanned. A gitlink (160000, a submodule
# pointer) has no blob to read and is skipped by the SHAPES arm; a symlink
# (120000) reads as its target string, which is harmless to scan.
entry_mode() {
  # The mode is the first field of the first line, so no NUL handling is needed
  # here — and keeping it out means the path-list conversion above is the only
  # place this guard converts anything.
  if [ "$mode" = index ]; then
    git ls-files --stage -- "$1" 2>/dev/null | head -1 | cut -d' ' -f1
  else
    git ls-tree "$commit" -- "$1" 2>/dev/null | head -1 | cut -d' ' -f1
  fi
}

# Content for a path in the mode we are running in. Never the working tree:
# the working tree can differ from what is being committed, and the working
# tree is not what leaves the machine.
read_blob() { # path -> writes $blob, returns git's status
  if [ "$mode" = index ]; then
    git show ":$1" > "$blob" 2>/dev/null
  else
    git show "$commit:$1" > "$blob" 2>/dev/null
  fi
}

refused=0
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

  case "$(entry_mode "$path")" in
    160000) continue ;;   # submodule pointer: nothing to read
  esac

  read_blob "$path"
  rc=$?
  [ "$rc" -ne 0 ] && fail_closed "could not read the committed content of '$path' (git show exited $rc)"

  # SHAPES. -I skips binary content. grep's own status decides: 0 matched,
  # 1 clean, anything else is a failed scan.
  grep -qIE "$shapes" "$blob"
  grc=$?
  [ "$grc" -ge 2 ] && fail_closed "the pattern scan of '$path' failed (grep exited $grc)"
  if [ "$grc" -eq 0 ]; then
    refused=1
    lines_hit=$(grep -nIE "$shapes" "$blob" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')
    shape_hits="$shape_hits$path: line(s) $lines_hit
"
  fi
done < "$list"

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
