#!/bin/sh
# Regression coverage for the agent-config rules in .gitignore.
#
# Backend config folders (.claude/, .codex/, .gemini/) hold machine-local
# settings, permissions and hooks at any depth, and stay untracked. The one
# exception is the root's .claude/skills/, which links the repo skills in
# .agents/skills/ for Claude Code. A bare `.claude/*` is anchored to the
# root, so it would let a nested package's .claude/ be added (Lumen, #870).
#
# Hermetic: a throwaway repository holding only this checkout's .gitignore,
# with the global and system git config and the global excludes file
# switched off, so a developer's own ignores cannot make a case pass.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
gitignore="$here/../.gitignore"
work=$(mktemp -d "${TMPDIR:-/tmp}/gitignore-agent-dirs.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM

git -C "$work" init -q
: > "$work/.git/info/exclude"
cp "$gitignore" "$work/.gitignore"

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
  mkdir -p "$work/$(dirname "$path")"
  : > "$work/$path"
done

failures=0
check() {
  # $1: "ignored" or "tracked"; $2: path
  if git -C "$work" -c core.excludesFile=/dev/null check-ignore -q --no-index "$2"; then
    actual=ignored
  else
    actual=tracked
  fi
  if [ "$actual" = "$1" ]; then
    echo "ok   $1: $2"
  else
    echo "FAIL want $1, got $actual: $2"
    failures=$((failures + 1))
  fi
}

for path in $ignored; do check ignored "$path"; done
for path in $tracked; do check tracked "$path"; done

# The cases above only mean something if check-ignore can say both things.
# Control: a repository with no .gitignore ignores none of them.
rm "$work/.gitignore"
if git -C "$work" -c core.excludesFile=/dev/null check-ignore -q --no-index .claude/settings.local.json; then
  echo "FAIL control: with no .gitignore, .claude/settings.local.json still reads as ignored"
  failures=$((failures + 1))
else
  echo "ok   control: nothing is ignored without the .gitignore"
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
