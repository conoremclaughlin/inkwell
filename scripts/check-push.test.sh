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

# The staged-file guard the replay calls refuses to run without a private-marker
# list (see scripts/check-staged-files.sh, MARKERS). This suite is about the
# replay, so it supplies an empty list: the opt-out, made explicit.
markers_fixture="$work/private-markers"
printf '# empty on purpose: this suite exercises the replay, not the markers\n' > "$markers_fixture"
INK_PRIVATE_MARKERS="$markers_fixture"
export INK_PRIVATE_MARKERS

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

# A credential file introduced only in a merge resolution (Lumen r1 #2),
# pushed for real.
r=$(new_pair mergepush "$hooks_dir")
commit_file "$r" base.txt 'base' 'feat: base'
git -C "$r" checkout -q -b topic
commit_file "$r" topic.txt 'topic' 'feat: topic'
git -C "$r" checkout -q main
commit_file "$r" main.txt 'main' 'feat: main'
git -C "$r" merge -q --no-commit --no-ff topic >/dev/null 2>&1
printf 'X=1' > "$r/.env.local"; git -C "$r" add -f .env.local
printf 'chore: merge topic\n' > "$r/.git/MSG"; git -C "$r" commit -q --no-verify -F "$r/.git/MSG"
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/mergepush.git" main)" ]; then
  ok "a credential file that exists only in a merge resolution blocks the push"
else
  bad "a credential file that exists only in a merge resolution blocks the push" "exit $rc; remote main: $(remote_head "$work/mergepush.git" main)"
fi

# Two remotes (Lumen r1 #3): a refused commit already on a private remote is
# still leaving the machine when it goes to a public one for the first time.
r=$(new_pair tworemotes "$hooks_dir")
commit_file "$r" a.txt 'one' 'test: synthetic secret assignment

JWT_SECRET=REVIEWCANARY0042' --no-verify
git init -q --bare "$work/tworemotes-private.git"
git -C "$r" remote add private "$work/tworemotes-private.git"
git -C "$r" -c core.hooksPath="$work/none" push -q private main >/dev/null 2>&1
[ -n "$(remote_head "$work/tworemotes-private.git" main)" ] || bad "fixture: private remote received the commit" "private push failed"
out=$(git -C "$r" push -u origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/tworemotes.git" main)" ]; then
  ok "a commit already on another remote is still replayed for a new remote and blocked"
else
  bad "a commit already on another remote is still replayed for a new remote and blocked" "exit $rc; origin main: $(remote_head "$work/tworemotes.git" main)"
fi
echo "$out" | grep -q 'REVIEWCANARY0042' && bad "two-remote refusal does not print the value" "value bytes in output" || ok "two-remote refusal does not print the value"

# ...and a commit the DESTINATION already has is not replayed again, even when
# the local remote-tracking ref for it is stale.
r=$(new_pair stale "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: already on origin'
git -C "$r" -c core.hooksPath="$work/none" push -q origin main >/dev/null 2>&1
git -C "$r" update-ref -d refs/remotes/origin/main 2>/dev/null   # forget what origin has
git -C "$r" checkout -q -b topic
commit_file "$r" t.txt 'topic' 'feat: only on topic'
st=$(git -C "$r" rev-parse --short HEAD)
out=$(git -C "$r" push -u origin topic 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a new branch pushes when tracking refs are stale" || bad "a new branch pushes when tracking refs are stale" "exit $rc: $(echo "$out" | tr '\n' ' ')"
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 1 ] && echo "$out" | grep -q -- "--- $st" && ok "exclusion is measured against the destination, not stale tracking refs" || bad "exclusion is measured against the destination, not stale tracking refs" "printed $c headers: $(echo "$out" | tr '\n' ' ')"

# Distinct fetch and push URLs (Lumen r2 #1): the hook's second argument is
# the push endpoint, and that is what must be listed. Seed the refused commit
# in origin's FETCH repo, point --push at an empty second repo: the push must
# be refused and the second repo must stay empty.
r=$(new_pair pushurl "$hooks_dir")
commit_file "$r" a.txt 'one' 'test: synthetic secret assignment

JWT_SECRET=REVIEWCANARY0043' --no-verify
git -C "$r" -c core.hooksPath="$work/none" push -q origin main >/dev/null 2>&1
[ -n "$(remote_head "$work/pushurl.git" main)" ] || bad "fixture: fetch repo received the commit" "seed push failed"
git init -q --bare "$work/pushurl-push.git"
git -C "$r" remote set-url --push origin "$work/pushurl-push.git"
out=$(git -C "$r" push origin main 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [ -z "$(remote_head "$work/pushurl-push.git" main)" ]; then
  ok "exclusion is measured against the PUSH url, so a commit only on the fetch url is still replayed and blocked"
else
  bad "exclusion is measured against the PUSH url" "exit $rc; push repo main: $(remote_head "$work/pushurl-push.git" main)"
fi
echo "$out" | grep -q 'REVIEWCANARY0043' && bad "pushurl refusal does not print the value" "value bytes in output" || ok "pushurl refusal does not print the value"

# ...and the other direction: the push endpoint already has the commit while
# the fetch repo does not, so nothing is replayed and the push is allowed.
r=$(new_pair pushurl2 "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: already on the push endpoint'
git init -q --bare "$work/pushurl2-push.git"
git -C "$r" -c core.hooksPath="$work/none" push -q "$work/pushurl2-push.git" main >/dev/null 2>&1
git -C "$r" remote set-url --push origin "$work/pushurl2-push.git"
commit_file "$r" b.txt 'two' 'feat: new on both'
s2=$(git -C "$r" rev-parse --short HEAD)
out=$(git -C "$r" push origin main 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "a push whose endpoint already has the older commit succeeds" || bad "a push whose endpoint already has the older commit succeeds" "exit $rc: $(echo "$out" | tr '\n' ' ')"
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 1 ] && echo "$out" | grep -q -- "--- $s2" && ok "only the commit the push endpoint lacks is replayed (fetch repo is empty and ignored)" || bad "only the commit the push endpoint lacks is replayed" "printed $c headers: $(echo "$out" | tr '\n' ' ')"

# A destination that cannot be listed is described, never printed: a URL may
# carry embedded credentials. Invoked directly, the way git would for a push
# to a raw URL, with an unreachable endpoint.
r=$(new_pair unlistable "$hooks_dir")
commit_file "$r" a.txt 'one' 'feat: fine'
sha=$(git -C "$r" rev-parse HEAD)
badurl='https://user:EMBEDDEDSECRET0044@127.0.0.1:1/nowhere.git'
out=$(cd "$r" && printf 'refs/heads/main %s refs/heads/main 0000000000000000000000000000000000000000\n' "$sha" | sh "$hooks_dir/../scripts/check-push.sh" "$badurl" "$badurl" 2>&1); rc=$?
echo "$out" | grep -q 'EMBEDDEDSECRET0044' && bad "an unlistable destination URL is never echoed" "URL credential in output" || ok "an unlistable destination URL is never echoed"
echo "$out" | grep -q 'could not list the refs of the destination URL' && ok "the unlistable destination is described generically" || bad "the unlistable destination is described generically" "$(echo "$out" | tr '\n' ' ')"
[ "$rc" -eq 0 ] && echo "$out" | grep -q -- "--- $(git -C "$r" rev-parse --short HEAD)" && ok "with nothing excludable, every reachable commit is replayed" || bad "with nothing excludable, every reachable commit is replayed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

echo "PREVIEW (scripts/check-push.sh --preview, the read-back before pushing)"

replay="$hooks_dir/../scripts/check-push.sh"

# The `clean` repo has origin/main from its pushes above; add one more commit.
r="$work/clean"
commit_file "$r" d.txt 'four' 'docs: a fourth, unpushed commit'
s4=$(git -C "$r" rev-parse --short HEAD)
out=$(cd "$r" && sh "$replay" --preview 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--preview exits 0 for clean unpushed commits" || bad "--preview exits 0 for clean unpushed commits" "exit $rc: $(echo "$out" | tr '\n' ' ')"
c=$(echo "$out" | grep -c -- '^--- ')
[ "$c" -eq 1 ] && echo "$out" | grep -q -- "--- $s4" && ok "--preview replays exactly origin/main..HEAD" || bad "--preview replays exactly origin/main..HEAD" "printed $c headers: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'a fourth, unpushed commit' && ok "--preview prints the clean message" || bad "--preview prints the clean message" "$(echo "$out" | tr '\n' ' ')"
[ "$(remote_head "$work/clean.git" main)" != "$(git -C "$r" rev-parse HEAD)" ] && ok "--preview does not push" || bad "--preview does not push" "remote moved"

# The `badmsg` repo never pushed, so name its first commit as the base.
r="$work/badmsg"
b=$(git -C "$r" rev-parse HEAD~1)
out=$(cd "$r" && sh "$replay" --preview "$b" 2>&1); rc=$?
[ "$rc" -eq 1 ] && ok "--preview exits 1 when a message is refused" || bad "--preview exits 1 when a message is refused" "exit $rc: $(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'CANARYVALUE9182' && bad "--preview does not print the refused value" "value bytes in output" || ok "--preview does not print the refused value"
echo "$out" | grep -q 'message withheld' && ok "--preview withholds the refused body" || bad "--preview withholds the refused body" "$(echo "$out" | tr '\n' ' ')"
echo "$out" | grep -q 'Do not push this' && ok "--preview says not to push" || bad "--preview says not to push" "$(echo "$out" | tr '\n' ' ')"

out=$(cd "$r" && sh "$replay" --preview no-such-ref 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "--preview with an unknown base fails closed (exit 2)" || bad "--preview with an unknown base fails closed" "exit $rc: $(echo "$out" | tr '\n' ' ')"

r="$work/clean"
out=$(cd "$r" && sh "$replay" --preview HEAD 2>&1); rc=$?
[ "$rc" -eq 0 ] && echo "$out" | grep -q 'Nothing to push' && ok "--preview with an empty range says so and exits 0" || bad "--preview with an empty range says so" "exit $rc: $(echo "$out" | tr '\n' ' ')"

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
