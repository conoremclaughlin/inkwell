#!/bin/sh
# Regression coverage for the pre-push replay (scripts/check-push.sh) and its
# hook (.husky/pre-push), exercised through real `git push` operations against
# a disposable bare remote.
#
# What is pinned:
#   - every commit message about to be pushed is printed, oldest first
#   - a message the commit-msg guard refuses blocks the push, even when the
#     commit was made with --no-verify
#   - a credential file in any pushed commit blocks the push
#   - only the range that actually leaves the machine is checked
#   - deleting a remote branch pushes nothing and is allowed
#   - a hook whose replay script is missing refuses rather than falling open
#
# Every fixture is SYNTHETIC. No real credential appears here.
#
# Usage:  sh scripts/check-push.test.sh
#
# HOOKS_UNDER_TEST points the suite at a copy of .husky so a deliberately
# broken replay can be checked for turning the suite red.

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
hooks_dir="${HOOKS_UNDER_TEST:-$root/.husky}"

git_isolate() {
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX \
    GIT_CONFIG GIT_CEILING_DIRECTORIES GIT_TEMPLATE_DIR GIT_INDEX_VERSION 2>/dev/null
  n=${GIT_CONFIG_COUNT:-0}
  case "$n" in '' | *[!0-9]*) n=0 ;; esac
  [ "$n" -lt 32 ] && n=32
  i=0
  while [ "$i" -lt "$n" ]; do
    unset "GIT_CONFIG_KEY_$i" "GIT_CONFIG_VALUE_$i" 2>/dev/null
    i=$((i + 1))
  done
  unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS 2>/dev/null
  GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
}
git_isolate

work=$(mktemp -d "${TMPDIR:-/tmp}/check-push-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT INT TERM

mkdir -p "$work/stubs"
printf '#!/bin/sh\nexit 0\n' > "$work/stubs/npx"
printf '#!/bin/sh\nexit 0\n' > "$work/stubs/yarn"
chmod +x "$work/stubs/npx" "$work/stubs/yarn"
PATH="$work/stubs:$PATH"
export PATH

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "  ok   $1"
}
bad() {
  fail=$((fail + 1))
  echo "  FAIL $1"
  [ $# -gt 1 ] && echo "         $2"
}

# A working repository wired to the hooks under test, with a bare remote.
new_pair() { # name
  bare="$work/$1.git"
  repo="$work/$1"
  git init -q --bare "$bare" || return 1
  git init -q -b main "$repo" || return 1
  git -C "$repo" config user.email tester@example.com
  git -C "$repo" config user.name tester
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath "$2"
  git -C "$repo" remote add origin "$bare"
  printf '%s\n' "$repo"
}

# Commit a file with a message read from a file (-F), optionally bypassing the
# commit-time hooks so the push-time replay is what gets exercised.
commit_file() { # repo path content message [--no-verify]
  mkdir -p "$(dirname "$1/$2")"
  printf '%s' "$3" > "$1/$2"
  git -C "$1" add -f -- "$2"
  printf '%s\n' "$4" > "$1/.git/MSG"
  if [ "${5:-}" = --no-verify ]; then
    git -C "$1" commit -q --no-verify -F "$1/.git/MSG"
  else
    git -C "$1" commit -q -F "$1/.git/MSG"
  fi
}

remote_head() { # bare ref
  git -C "$1" rev-parse -q --verify "refs/heads/$2" 2>/dev/null
}

echo "REPLAY (scripts/check-push.sh via .husky/pre-push)"

r=$(new_pair clean "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: the first commit'
commit_file "$r" b.txt 'two' 'fix: the second commit

With a body that mentions a `local` flag and $(nothing) executed.'
s1=$(git -C "$r" rev-parse --short HEAD~1)
s2=$(git -C "$r" rev-parse --short HEAD)
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -eq 0 ] && [ "$(remote_head "$work/clean.git" main)" = "$(git -C "$r" rev-parse HEAD)" ]; then
  ok "two clean commits push"
else
  bad "two clean commits push" "exit $rc: $(echo "$out" | tr '\n' ' ')"
fi
echo "$out" | grep -q -- "--- $s1" && echo "$out" | grep -q -- "--- $s2" && ok "both commit messages are printed with their short SHAs" || bad "both commit messages are printed" "$(echo "$out" | tr '\n' ' ')"
first=$(echo "$out" | grep -n -- "--- $s1" | cut -d: -f1)
second=$(echo "$out" | grep -n -- "--- $s2" | cut -d: -f1)
[ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] && ok "messages are printed oldest first" || bad "messages are printed oldest first" "first at $first, second at $second"
echo "$out" | grep -q 'mentions a `local` flag' && ok "message bodies are printed, not only subjects" || bad "message bodies are printed" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q '2 commit message(s) printed above and scanned clean' && ok "summary line counts the commits" || bad "summary line counts the commits" "$(echo "$out" | tr '\n' ' ')"

# Only the new range is checked once the remote has history.
commit_file "$r" c.txt 'three' 'chore: the third commit'
s3=$(git -C "$r" rev-parse --short HEAD)
out=$(git -C "$r" push origin main 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a follow-up push succeeds" || bad "a follow-up push succeeds" "exit $rc: $(echo "$out" | tr '\n' ' ')"
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 1 ] && echo "$out" | grep -q -- "--- $s3" && ok "only the commits not yet on the remote are replayed" || bad "only the commits not yet on the remote are replayed" "printed $c headers: $(echo "$out" | tr '\n' ' ')"

# A refused message, committed past the commit-msg hook with --no-verify.
r=$(new_pair badmsg "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: fine'
commit_file "$r" b.txt 'two' 'fix: pasted the env

SUPABASE_SECRET_KEY=CANARYVALUE9182' --no-verify
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/badmsg.git" main)" ]; then
  ok "a credential in any pushed message blocks the push and nothing lands"
else
  bad "a credential in any pushed message blocks the push" "exit $rc; remote main: $(remote_head "$work/badmsg.git" main)"
fi
echo "$out" | grep -q 'Push blocked' && ok "refusal is worded as a push block" || bad "refusal is worded as a push block" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'SUPABASE_SECRET_KEY' && ok "refusal names the variable" || bad "refusal names the variable" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'CANARYVALUE9182' && bad "refusal does not print the value" "value bytes in output" || ok "refusal does not print the value"
echo "$out" | grep -q 'message withheld: refused by the credential guard' && ok "a refused message body is withheld, not printed" || bad "a refused message body is withheld, not printed" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'pasted the env' && bad "not even the subject of a refused message is printed" "subject leaked" || ok "not even the subject of a refused message is printed"

# A credential file, committed past pre-commit with --no-verify.
r=$(new_pair badfile "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: fine'
commit_file "$r" .env.local 'X=1' 'chore: oops' --no-verify
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/badfile.git" main)" ]; then
  ok "a credential file in any pushed commit blocks the push"
else
  bad "a credential file in any pushed commit blocks the push" "exit $rc"
fi
echo "$out" | grep -q '\.env\.local' && ok "refusal names the file" || bad "refusal names the file" "$(echo "$out" | tr '\n' ' ')"

# A bad commit that is already on the remote (pushed before the guard existed)
# does not block pushing a clean commit on top: only the new range is checked.
r=$(new_pair legacy "$hooks_dir")
commit_file "$r" a.txt 'one' 'chore: pre-guard commit

SUPABASE_SECRET_KEY=LEGACY0000' --no-verify
git -C "$r" -c core.hooksPath="$work/none" push -q -u origin main >/dev/null 2>&1
commit_file "$r" b.txt 'two' 'feat: clean follow-up'
out=$(git -C "$r" push origin main 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "history already on the remote is not re-scanned" || bad "history already on the remote is not re-scanned" "exit $rc: $(echo "$out" | tr '\n' ' ')"

# Deleting a remote branch pushes no commits.
r=$(new_pair delete "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: fine'
git -C "$r" push -q -u origin main >/dev/null 2>&1
git -C "$r" push -q origin main:refs/heads/topic >/dev/null 2>&1
out=$(git -C "$r" push origin --delete topic 2>&1); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(remote_head "$work/delete.git" topic)" ]; then
  ok "deleting a remote branch is allowed and prints no messages"
else
  bad "deleting a remote branch is allowed" "exit $rc: $(echo "$out" | tr '\n' ' ')"
fi
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 0 ] && ok "a delete replays nothing" || bad "a delete replays nothing" "printed $c headers"

# A new branch cut from an already-pushed branch replays only its own commits.
r=$(new_pair branch "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: on main'
git -C "$r" push -q -u origin main >/dev/null 2>&1
git -C "$r" checkout -q -b topic
commit_file "$r" t.txt 'topic' 'feat: on topic'
st=$(git -C "$r" rev-parse --short HEAD)
out=$(git -C "$r" push -u origin topic 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a new branch pushes" || bad "a new branch pushes" "exit $rc: $(echo "$out" | tr '\n' ' ')"
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 1 ] && echo "$out" | grep -q -- "--- $st" && ok "a new branch replays only the commits no remote has" || bad "a new branch replays only the commits no remote has" "printed $c headers: $(echo "$out" | tr '\n' ' ')"

echo "WIRING (.husky/pre-push fails closed)"

mkdir -p "$work/broken-hooks/.husky"
cp "$hooks_dir/pre-push" "$work/broken-hooks/.husky/pre-push"
chmod +x "$work/broken-hooks/.husky/pre-push"
r=$(new_pair broken "$work/broken-hooks/.husky")
git -C "$r" -c core.hooksPath="$work/none" commit -q --allow-empty -m 'feat: fixture' 2>/dev/null
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/broken.git" main)" ]; then
  ok "pre-push with a missing replay script refuses rather than falling open"
else
  bad "pre-push with a missing replay script refuses rather than falling open" "exit $rc"
fi
echo "$out" | grep -q 'missing its readable replay script' && ok "missing-replay refusal says what is missing" || bad "missing-replay refusal says what is missing" "$(echo "$out" | tr '\n' ' ')"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
