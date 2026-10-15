#!/bin/sh
# Regression coverage for the agent-config rules in .gitignore.
#
# Backend config folders (.claude/, .codex/, .gemini/) hold machine-local
# settings, permissions and hooks at any depth, and stay untracked. The one
# exception is the root's .claude/skills/, which links the repo skills in
# .agents/skills/ for Claude Code. A bare `.claude/*` is anchored to the
# root, so it would let a nested package's .claude/ be added (Lumen, #870).
#
# Hermetic: a throwaway repository holding only this checkout's .gitignore.
# Every git call runs under `env -i` with a temporary HOME, no system or
# global config and no global excludes file, so neither a developer's own
# ignores nor an inherited GIT_DIR, GIT_WORK_TREE or GIT_CONFIG_PARAMETERS
# can steer it (Lumen, #870). The script plants those variables itself,
# aimed at a decoy, and checks the decoy is never written.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
gitignore="$here/../.gitignore"
git_bin=$(command -v git)
work=$(mktemp -d "${TMPDIR:-/tmp}/gitignore-agent-dirs.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
repo="$work/repo"
decoy="$work/decoy"
mkdir -p "$repo" "$decoy" "$work/home"

# What a caller might leak in. Every git call below must ignore all of it.
GIT_DIR="$decoy/.git"
GIT_WORK_TREE="$decoy"
GIT_INDEX_FILE="$decoy/index"
GIT_CONFIG_PARAMETERS="'core.excludesfile=$decoy/excludes'"
export GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_CONFIG_PARAMETERS

git_clean() {
  env -i HOME="$work/home" PATH=/usr/bin:/bin LANG=C \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    "$git_bin" -c core.excludesFile=/dev/null "$@"
}

git_clean -C "$repo" init -q
if [ ! -d "$repo/.git" ]; then
  echo "FAIL isolation: git init did not create $repo/.git; an inherited GIT_DIR redirected it"
  exit 1
fi
: > "$repo/.git/info/exclude"
cp "$gitignore" "$repo/.gitignore"

ignored='
.claude/settings.local.json
.claude/settings.json
.claude/worktrees/x/state.json
.claude/commands/local.md
packages/web/.claude/settings.local.json
packages/web/.claude/skills/local/SKILL.md
a/b/.claude/commands/local.md
.codex/config.toml
packages/web/.codex/hooks.json
.gemini/settings.json
'
tracked='
.claude/skills/example/SKILL.md
.agents/skills/example/SKILL.md
'

for path in $ignored $tracked; do
  mkdir -p "$repo/$(dirname "$path")"
  : > "$repo/$path"
done

failures=0
fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}
check() {
  # $1: "ignored" or "tracked"; $2: path
  if git_clean -C "$repo" check-ignore -q --no-index "$2"; then
    actual=ignored
  else
    actual=tracked
  fi
  if [ "$actual" = "$1" ]; then
    echo "ok   $1: $2"
  else
    fail "want $1, got $actual: $2"
  fi
}

for path in $ignored; do check ignored "$path"; done
for path in $tracked; do check tracked "$path"; done

# The cases above only mean something if check-ignore can say both things.
# Control: a repository with no .gitignore ignores none of them.
rm "$repo/.gitignore"
if git_clean -C "$repo" check-ignore -q --no-index .claude/settings.local.json; then
  fail "control: with no .gitignore, .claude/settings.local.json still reads as ignored"
else
  echo "ok   control: nothing is ignored without the .gitignore"
fi

# The planted variables never reached git: the decoy is still empty.
if [ -n "$(ls -A "$decoy")" ]; then
  fail "the inherited GIT_DIR/GIT_WORK_TREE reached a git call: $decoy was written"
else
  echo "ok   isolation: the planted GIT_DIR decoy was never written"
fi

# Control for that check: a git call that is handed the planted variables
# writes the decoy, so an empty decoy above is evidence. It gets those four
# and nothing else from this shell (Lumen, #870).
(cd "$work" && env -i HOME="$work/home" PATH=/usr/bin:/bin LANG=C \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  GIT_DIR="$GIT_DIR" GIT_WORK_TREE="$GIT_WORK_TREE" \
  GIT_INDEX_FILE="$GIT_INDEX_FILE" GIT_CONFIG_PARAMETERS="$GIT_CONFIG_PARAMETERS" \
  "$git_bin" init -q 2>/dev/null) || true
if [ -e "$decoy/.git/HEAD" ]; then
  echo "ok   control: a git call handed the planted variables writes the decoy"
else
  fail "control: a git call handed the planted variables left the decoy empty, so the isolation check proves nothing"
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
