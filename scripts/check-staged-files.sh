#!/bin/sh
# Refuse a commit (or a push) that carries a file no commit should ever carry,
# or content that names a real person.
#
# Four arms, all value-free in what they print:
#
#   NAMES     — files that are credentials by construction: dotenv files that
#               are not examples, private keys, the ink identity/auth files,
#               MCP and Claude local settings, git and postgres credential
#               files. These are refused on the PATH alone, before anything
#               reads them.
#
#   SHAPES    — vendor token formats (scripts/lib/credential-patterns.sh)
#               inside any text file being committed. Reported as path and
#               line numbers, never the matched bytes.
#
#   ADDRESSES — an email address whose domain is neither reserved for examples
#               nor listed in scripts/lib/fixture-domains.sh. A fixture built
#               by pasting a real message carries the real sender, and a real
#               sender's domain is not on that list; putting it there is a
#               visible edit in the diff, which is the point. Reported as path
#               and line numbers; the address is not printed.
#
#   MARKERS   — literal strings the machine's owner never wants in a tracked
#               file (a clinic, a doctor, a treatment, a chat id), read from a
#               file OUTSIDE the repository: ~/.ink/private-markers, or the
#               path in INK_PRIVATE_MARKERS. One per line, matched as a fixed
#               string without regard to case; # comments and blank lines are
#               ignored. The list lives outside the tree because a list of
#               your own personal data is itself personal data. A MISSING list
#               refuses the operation: the machine that holds the mail is the
#               machine that must carry the list, and "not configured" must
#               never read as "nothing found". An EMPTY list is the explicit
#               opt-out. Reported as path and line numbers; the marker is not
#               printed. Setup is one file, no install: the refusal message
#               and AGENTS.md (Testing) both say how.
#
# Two paths are exempt from the ADDRESSES and MARKERS arms and from nothing
# else: .mailmap, whose purpose is real author addresses that every commit
# object already carries, and .yarn/, which is vendored.
#
# The commit-msg guard cannot see files and this guard cannot see the message;
# they are two halves. This one exists because `git add .` and `git add -A`
# stage untracked files nobody looked at, because a credential pasted into a
# source file or a fixture looks like ordinary text in a diff — and because a
# real person pasted into a fixture looks like an ordinary fixture. The rule
# against that had been written down for months before the guard existed; the
# rule with a machine behind it is the one that holds.
#
# Usage:
#   scripts/check-staged-files.sh               scan the index (pre-commit)
#   scripts/check-staged-files.sh --commit SHA  scan what SHA changes against
#                                               its FIRST PARENT (the empty tree
#                                               for a root commit), so a merge
#                                               commit's resolution is scanned
#                                               like any other change (pre-push)
#   scripts/check-staged-files.sh --tree [REV]  scan EVERY tracked file at REV
#                                               (default HEAD). This is the CI
#                                               invariant that keeps main clean
#                                               and the check to run after a
#                                               scrub; the other two modes only
#                                               ever see what is changing.
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

# Both libraries are sourced, and a library that cannot be read or that loads
# empty refuses rather than scanning with nothing. Same rule for both: a guard
# that silently ran with half its lists is the shape of failure this file
# exists to rule out.
load_lib() { # path what
  if [ ! -f "$1" ] || [ ! -r "$1" ]; then
    echo "" >&2
    echo "Blocked: the staged-file guard cannot read its $2 at" >&2
    echo "   $1" >&2
    echo "   Nothing was checked, so nothing is allowed through. Repair the checkout" >&2
    echo "   that owns core.hooksPath." >&2
    echo "" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  . "$1"
}
load_lib "$here/lib/credential-patterns.sh" "pattern library"
case "${shapes:-}" in
  '')
    echo "Blocked: the pattern library loaded but defines no shapes; refusing rather than scanning with nothing." >&2
    exit 2
    ;;
esac
load_lib "$here/lib/fixture-domains.sh" "fixture-domain list"
case "${fixture_domains_legacy:-}${fixture_domains_infra:-}" in
  '')
    echo "Blocked: the fixture-domain list loaded but defines no domains; refusing rather than scanning with nothing." >&2
    exit 2
    ;;
esac

mode=index
rev=''
case "${1:-}" in
  '') ;;
  --commit)
    mode=commit
    rev=${2:-}
    if [ -z "$rev" ]; then
      echo "usage: $0 [--commit SHA | --tree [REV]]" >&2
      exit 2
    fi
    ;;
  --tree)
    mode=tree
    rev=${2:-HEAD}
    ;;
  *)
    echo "usage: $0 [--commit SHA | --tree [REV]]" >&2
    exit 2
    ;;
esac

fail_closed() { # reason...
  echo "" >&2
  case "$mode" in
    index) echo "Commit blocked: the staged-file scan did not complete." >&2 ;;
    commit) echo "Push blocked: the file scan of commit $rev did not complete." >&2 ;;
    tree) echo "Tree check failed: the scan of $rev did not complete." >&2 ;;
  esac
  printf '   %s\n' "$@" >&2
  echo "   A scan that errors is not a scan that found nothing, so the operation" >&2
  echo "   is refused. Nothing has been committed or pushed." >&2
  echo "" >&2
  exit 2
}

raw=$(mktemp "${TMPDIR:-/tmp}/check-staged-paths.XXXXXX") || exit 2
list=$(mktemp "${TMPDIR:-/tmp}/check-staged-list.XXXXXX") || { rm -f "$raw"; exit 2; }
blob=$(mktemp "${TMPDIR:-/tmp}/check-staged-blob.XXXXXX") || { rm -f "$raw" "$list"; exit 2; }
markers_raw=$(mktemp "${TMPDIR:-/tmp}/check-staged-markers-raw.XXXXXX") || { rm -f "$raw" "$list" "$blob"; exit 2; }
markers=$(mktemp "${TMPDIR:-/tmp}/check-staged-markers.XXXXXX") || { rm -f "$raw" "$list" "$blob" "$markers_raw"; exit 2; }
trap 'rm -f "$raw" "$list" "$blob" "$markers_raw" "$markers"' EXIT INT TERM

# The private-marker list. Resolved before anything is listed, so a machine
# that is not configured finds out on its first commit rather than on the one
# that happens to carry the data.
markers_src=${INK_PRIVATE_MARKERS:-${HOME:-}/.ink/private-markers}
if [ ! -f "$markers_src" ] || [ ! -r "$markers_src" ]; then
  echo "" >&2
  echo "Blocked: the private-marker list is missing or unreadable at" >&2
  echo "   $markers_src" >&2
  echo "   The staged-file guard refuses personal data by matching the literal" >&2
  echo "   strings in that file: one per line, case-insensitive, # comments and" >&2
  echo "   blank lines ignored. A missing list is not an empty one. Create it" >&2
  echo "   (an empty file is the explicit opt-out) or point INK_PRIVATE_MARKERS" >&2
  echo "   at the list to use. Nothing was checked, so nothing is allowed through." >&2
  echo "" >&2
  echo "   To create it, then fill it with the strings that would identify you or" >&2
  echo "   the people in your life if a pasted message carried them:" >&2
  echo "" >&2
  printf '%s\n' "      mkdir -p ~/.ink && touch ~/.ink/private-markers" >&2
  echo "" >&2
  echo "   The setup notes are under Testing in AGENTS.md." >&2
  echo "" >&2
  exit 2
fi
# Strip CRs, trailing whitespace, comments and blank lines, each step checked
# on its own status. A blank pattern handed to grep matches every line, so the
# filter is load-bearing and its failure is a failed scan, not an empty list.
tr -d '\r' < "$markers_src" > "$markers_raw" || fail_closed "could not read the private-marker list at $markers_src"
sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^$/d' "$markers_raw" > "$markers" || fail_closed "could not filter the private-marker list at $markers_src"
markers_count=$(grep -c '' "$markers")
case "$markers_count" in '' | *[!0-9]*) fail_closed "could not count the private markers" ;; esac

# The comparison base for --commit: the first parent, or the empty tree for a
# root commit. `git diff-tree <sha>` alone shows NOTHING for a merge commit,
# which is how a credential file introduced in a merge resolution used to pass.
parent=''
if [ "$mode" = commit ]; then
  parent=$(git rev-parse -q --verify "$rev^1" 2>/dev/null)
  if [ -z "$parent" ]; then
    parent=$(git hash-object -t tree /dev/null) || fail_closed "could not compute the empty tree"
  fi
fi

# The path list, NUL-separated. T (type change) is included: a symlink replaced
# by a regular file has new content that must be scanned. Tree mode lists every
# blob at the revision; there is no "change" to filter on.
case "$mode" in
  index)
    git diff --cached --name-only -z --diff-filter=ACMRT > "$raw"
    rc=$?
    ;;
  commit)
    git diff --name-only -z --diff-filter=ACMRT "$parent" "$rev" > "$raw"
    rc=$?
    ;;
  tree)
    git ls-tree -r -z --name-only "$rev" > "$raw"
    rc=$?
    ;;
esac
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

# Paths the ADDRESSES and MARKERS arms do not read. Exactly two, each for a
# reason that does not generalise: git's author map exists to hold the real
# addresses that every commit object carries anyway, and the vendored yarn
# release is not our text. Nothing else is exempt, fixtures least of all.
personal_exempt() {
  case "/$1" in
    /.mailmap) return 0 ;;
    /.yarn/*) return 0 ;;
  esac
  return 1
}

# ADDRESSES. The shape is deliberately loose — a local part, an at sign, a
# dotted host — because the decision is made on the domain, not the match.
# (The previous wording of this comment was an address, and the guard caught it.)
email_re='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

# The rules from scripts/lib/fixture-domains.sh. The caller has already folded
# case. Hyphens are trimmed from each label so that a fixture testing rejection
# of `a@-example.com` still reads as an example.
domain_allowed() { # domain
  d=$1
  case "$d" in *.) d=${d%.} ;; esac
  case "${d##*.}" in test | invalid | example | localhost) return 0 ;; esac
  rest=$d
  while :; do
    label=${rest%%.*}
    while [ "${label#-}" != "$label" ]; do label=${label#-}; done
    while [ "${label%-}" != "$label" ]; do label=${label%-}; done
    [ "$label" = example ] && return 0
    case "$rest" in *.*) rest=${rest#*.} ;; *) break ;; esac
  done
  for allowed in $fixture_domains_legacy $fixture_domains_infra; do
    [ "$d" = "$allowed" ] && return 0
    case "$d" in *".$allowed") return 0 ;; esac
  done
  return 1
}

# The entry's mode in the tree being scanned. A gitlink (160000, a submodule
# pointer) has no blob to read and is skipped by the content arms; a symlink
# (120000) reads as its target string, which is harmless to scan.
entry_mode() {
  # The mode is the first field of the first line, so no NUL handling is needed
  # here — and keeping it out means the path-list conversion above is the only
  # place this guard converts anything.
  case "$mode" in
    index) git ls-files --stage -- "$1" 2>/dev/null | head -1 | cut -d' ' -f1 ;;
    *) git ls-tree "$rev" -- "$1" 2>/dev/null | head -1 | cut -d' ' -f1 ;;
  esac
}

# Content for a path in the mode we are running in. Never the working tree:
# the working tree can differ from what is being committed, and the working
# tree is not what leaves the machine.
read_blob() { # path -> writes $blob, returns git's status
  case "$mode" in
    index) git show ":$1" > "$blob" 2>/dev/null ;;
    *) git show "$rev:$1" > "$blob" 2>/dev/null ;;
  esac
}

refused=0
name_hits=''
shape_hits=''
addr_hits=''
marker_hits=''

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

  personal_exempt "$path" && continue

  # ADDRESSES. Every match is taken with its line number, folded to lower
  # case once per file, and judged in the shell on its domain alone. The
  # matches never reach the report; only the line numbers of the refused
  # ones do.
  addr_raw=$(grep -nioIE "$email_re" "$blob")
  grc=$?
  [ "$grc" -ge 2 ] && fail_closed "the address scan of '$path' failed (grep exited $grc)"
  if [ "$grc" -eq 0 ]; then
    addr_lower=$(printf '%s\n' "$addr_raw" | tr 'A-Z' 'a-z') || fail_closed "could not fold the addresses in '$path'"
    bad_lines=''
    # Each item is N:local@domain and the pattern admits no whitespace, so
    # default word splitting yields exactly one item per match.
    for m in $addr_lower; do
      n=${m%%:*}
      d=${m##*@}
      if ! domain_allowed "$d"; then
        case ",$bad_lines," in
          *",$n,"*) ;;
          *) bad_lines="${bad_lines:+$bad_lines,}$n" ;;
        esac
      fi
    done
    if [ -n "$bad_lines" ]; then
      refused=1
      addr_hits="$addr_hits$path: line(s) $bad_lines
"
    fi
  fi

  # MARKERS. Fixed strings, case folded, from the private list. Skipped
  # entirely when the list is empty rather than handed to grep empty.
  if [ "$markers_count" -gt 0 ]; then
    grep -qiIF -f "$markers" "$blob"
    mrc=$?
    [ "$mrc" -ge 2 ] && fail_closed "the marker scan of '$path' failed (grep exited $mrc)"
    if [ "$mrc" -eq 0 ]; then
      refused=1
      lines_hit=$(grep -niIF -f "$markers" "$blob" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')
      marker_hits="$marker_hits$path: line(s) $lines_hit
"
    fi
  fi
done < "$list"

if [ "$refused" -eq 1 ]; then
  echo ""
  case "$mode" in
    index) echo "Commit blocked: the staged files include something that must never be committed." ;;
    commit) echo "Push blocked: commit $rev carries something that must never be committed." ;;
    tree) echo "Tree check failed: $rev carries something that must never be tracked." ;;
  esac
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
  if [ -n "$addr_hits" ]; then
    echo "   Email address on a domain that is neither reserved for examples nor"
    echo "   listed in scripts/lib/fixture-domains.sh (the address is not printed):"
    printf '%s' "$addr_hits" | while IFS= read -r h; do
      [ -n "$h" ] && printf '      %s\n' "$h"
    done
    echo "      Fixtures use invented people at example.com or under .test, .example"
    echo "      or .invalid. A message pasted from a real mailbox carries a real"
    echo "      person: rewrite the fixture, do not extend the list."
  fi
  if [ -n "$marker_hits" ]; then
    echo "   Matches a private marker from $markers_src (the marker is not printed):"
    printf '%s' "$marker_hits" | while IFS= read -r h; do
      [ -n "$h" ] && printf '      %s\n' "$h"
    done
  fi
  echo ""
  case "$mode" in
    index)
      echo "   Unstage it (git restore --staged <path>) and stage by naming the paths"
      echo "   you mean. git add -A and git add . are how these get in."
      echo "   Nothing has been committed; your index is untouched."
      ;;
    commit)
      echo "   The commit was created with hooks bypassed or before the guard existed."
      echo "   Rewrite it locally before pushing; a pushed credential is public."
      ;;
    tree)
      echo "   The tree already carries this. Fix it forward on a branch, and treat"
      echo "   anything personal as an incident: tell the owner, then decide about"
      echo "   the history it sits in."
      ;;
  esac
  echo ""
  exit 1
fi

exit 0
