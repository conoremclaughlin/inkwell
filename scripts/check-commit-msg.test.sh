#!/bin/sh
# Regression coverage for the commit-message credential guard.
#
# Two tiers, because the guard has two halves that fail independently:
#
#   SCANNER  — scripts/check-commit-msg.sh, called directly on fixture messages.
#   WIRING   — .husky/commit-msg, exercised through a real `git commit` in a
#              disposable repository. A scanner that works and a hook that never
#              invokes it look identical from the scanner's own tests, so the
#              wiring gets its own tier rather than being assumed.
#
# Every fixture here is SYNTHETIC. The values match the vendor shapes the
# scanner looks for and are otherwise nonsense; no real credential, and no real
# leaking commit message, appears in this file or anywhere else in the tree.
# The three historical leaks are exercised by SHA against local history in
# scripts/check-commit-msg.history.sh, which reads git objects and never copies
# them into a tracked file.
#
# Usage:  sh scripts/check-commit-msg.test.sh

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
guard="$root/scripts/check-commit-msg.sh"
hook="$root/.husky/commit-msg"

work=$(mktemp -d "${TMPDIR:-/tmp}/check-commit-msg-test.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT INT TERM

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

# write_msg <name> <<'EOF' ... EOF  — returns the fixture path on stdout.
write_msg() {
  path="$work/$1.msg"
  cat > "$path"
  echo "$path"
}

# Synthetic tokens. Built by repetition so the character counts that the
# scanner's {36}/{33}/{20} intervals depend on are not hand-miscounted; if one
# is too short the shape stops matching and the test that expects a block fails
# loudly rather than passing for the wrong reason.
F4=FAKE
F20=$F4$F4$F4$F4$F4
F32=$F20$F4$F4$F4
F36=$F32$F4
F33=${F32}F

# ---------------------------------------------------------------------------
# Tier 1: the scanner
# ---------------------------------------------------------------------------

echo "SCANNER (scripts/check-commit-msg.sh)"

# expect_exit <expected> <label> <fixture-path>
expect_exit() {
  want=$1
  label=$2
  file=$3
  out=$(sh "$guard" "$file" 2>&1)
  got=$?
  if [ "$got" -eq "$want" ]; then
    ok "$label"
  else
    bad "$label" "expected exit $want, got $got; output: $(echo "$out" | tr '\n' ' ')"
  fi
}

# --- messages that must be ALLOWED (exit 0) -------------------------------

f=$(write_msg clean-subject <<'EOF'
chore: bump typescript to 5.4
EOF
)
expect_exit 0 "plain one-line subject is allowed" "$f"

# The false positive that matters most. This is the exact shape of prose that
# caused the incident: markdown backticks around an identifier. If the guard
# ever flags this it will be disabled within a day and the protection is worth
# nothing, so it is pinned as a test rather than left to judgement.
f=$(write_msg clean-backticks <<'EOF'
fix(cache): honour a `local` flag on the cache entry

The entry carried a `local` flag that `which` never consulted, so a
$(computed) lookup fell through to the shared path. Prose here deliberately
contains backticks, $(...) and ${BRACES} because ordinary commit messages do.

Co-Authored-By: Wren <noreply@anthropic.com>
EOF
)
expect_exit 0 "prose with backticks and \$(...) is allowed" "$f"

# Talking about environment variables is normal in this repo's commit messages.
# Names alone, and assignments that are not at the start of a line, are prose.
f=$(write_msg clean-env-prose <<'EOF'
docs: explain the isolated-server env flags

Set ENABLE_HEARTBEATS and ENABLE_GRAPH_SWEEP to false on a test server. The
recipe used to say ENABLE_HEARTBEAT_SERVICE=false, which was read by nothing.
Resolution is INK_PORT_BASE || PCP_PORT_BASE.
EOF
)
expect_exit 0 "prose mentioning env var names is allowed" "$f"

# Documents the calibrated threshold: two assignment lines are under it. The
# scanner's comment claims nothing legitimate reaches three; this pins the
# boundary so a future edit to the threshold cannot move silently.
f=$(write_msg dump-two <<'EOF'
test: document the fixture environment

RANDOM_THING_ONE=alpha
ANOTHER_THING_TWO=beta
EOF
)
expect_exit 0 "two assignment lines stay under the dump threshold" "$f"

# --- messages that must be BLOCKED (exit 1) -------------------------------

f=$(write_msg named-var <<EOF
fix: something ordinary

SUPABASE_SECRET_KEY=CANARYVALUE9182
EOF
)
expect_exit 1 "named secret assignment is blocked" "$f"

# The hook's own output must never become the next place the secret is written
# down. This is the property that makes the guard safe to run in CI logs.
out=$(sh "$guard" "$f" 2>&1)
if echo "$out" | grep -q CANARYVALUE9182; then
  bad "scanner output does not echo the secret value" "output contained the value"
else
  ok "scanner output does not echo the secret value"
fi
if echo "$out" | grep -q SUPABASE_SECRET_KEY; then
  ok "scanner output names the offending variable"
else
  bad "scanner output names the offending variable" "output: $(echo "$out" | tr '\n' ' ')"
fi

# Checking for the whole canary is too weak to pin this. The named arm matches
# one byte past the `=`, and `grep -o` reports what it matched, so dropping the
# strip leaks the first character of the secret and the whole-value check stays
# green. One byte is still disclosure, and a one-byte regression is exactly the
# kind that survives review. Assert the shape instead: a reported line is
# "line N: NAME" and carries no `=` at all, so no value byte can ride along.
reported=$(echo "$out" | grep '^   line ')
if [ -z "$reported" ]; then
  bad "reported hit lines carry no value bytes" "no 'line N:' output to check"
elif echo "$reported" | grep -q '='; then
  bad "reported hit lines carry no value bytes" "reported: $(echo "$reported" | tr '\n' ' ')"
else
  ok "reported hit lines carry no value bytes"
fi

# A $(...) span splices its output into the middle of a sentence rather than
# onto a line of its own, so the named arm is not anchored to line start. That
# is the shape an anchored pattern reads straight past.
f=$(write_msg midline-splice <<'EOF'
fix: honour the JWT_SECRET=s3cretvalue flag on the cache entry
EOF
)
expect_exit 1 "secret spliced mid-sentence is blocked" "$f"

# Prefixed names. The word boundary in front of the named list excludes _, so
# without the optional prefix group these read through -- and a dump prints the
# names the environment really has, which here are routinely prefixed.
f=$(write_msg prefixed-name <<'EOF'
fix: honour the PCP_JWT_SECRET=s3cretvalue flag
EOF
)
expect_exit 1 "prefixed secret name is blocked" "$f"

out=$(sh "$guard" "$f" 2>&1)
if echo "$out" | grep -q "PCP_JWT_SECRET"; then
  ok "prefixed name is reported in full, not just the matched tail"
else
  bad "prefixed name is reported in full, not just the matched tail" "output: $(echo "$out" | tr '\n' ' ')"
fi

# The other side of unanchoring: prose about these variables must still pass, or
# every future commit discussing the guard trips it. Placeholders are written
# <like-this> or ***, and no real credential starts with either byte.
f=$(write_msg placeholder-prose <<'EOF'
docs: explain the guard

A spliced span looks like JWT_SECRET=<value> once it lands. Redacted logs
render it as GITHUB_TOKEN=*** instead. To run locally, set JWT_SECRET= in
your env first.
EOF
)
expect_exit 0 "placeholder and bare-assignment prose is allowed" "$f"

# The value byte is a whitelist rather than a punctuation blacklist, because a
# blacklist kept losing a byte at a time to ordinary prose about this guard.
# Both of these were live false positives on real commit messages for this PR:
# a name list where the sentence ends on the =, and a quoted short example.
f=$(write_msg prose-ends-on-equals <<'EOF'
fix: widen the named arm

The boundary excluded underscore, so the arm matched JWT_SECRET= but not
PCP_JWT_SECRET= or MY_GITHUB_TOKEN=. Both were allowed; both are closed now,
and a list like GITHUB_TOKEN=, JWT_SECRET= reads as prose rather than a leak.
EOF
)
expect_exit 0 "prose whose sentence ends on the equals sign is allowed" "$f"

f=$(write_msg dump-three <<'EOF'
fix: a message that swallowed an environment dump

RANDOM_THING_ONE=alpha
ANOTHER_THING_TWO=beta
THIRD_THING_HERE=gamma
EOF
)
expect_exit 1 "three unnamed assignment lines trip the dump heuristic" "$f"

# Vendor shapes, for secrets that carry no recognised variable name. Each is
# checked on its own so a regex that rots only for one vendor is still caught.
for case in \
  "github-pat-classic:ghp_$F36" \
  "github-pat-fine:github_pat_$F20" \
  "google-client-secret:GOCSPX-$F20" \
  "supabase-secret:sb_secret_$F20" \
  "anthropic-key:sk-ant-$F20" \
  "telegram-bot:123456789:AA$F33" \
; do
  label=${case%%:*}
  token=${case#*:}
  f=$(printf 'fix: an ordinary subject line\n\nPasted: %s\n' "$token" | write_msg "shape-$label")
  expect_exit 1 "vendor shape blocked: $label" "$f"
done

# --- argument handling ----------------------------------------------------

out=$(sh "$guard" 2>&1)
got=$?
if [ "$got" -eq 2 ]; then
  ok "missing argument exits 2"
else
  bad "missing argument exits 2" "got $got"
fi

out=$(sh "$guard" "$work/does-not-exist.msg" 2>&1)
got=$?
if [ "$got" -eq 2 ]; then
  ok "nonexistent message file exits 2"
else
  bad "nonexistent message file exits 2" "got $got"
fi

# ---------------------------------------------------------------------------
# Tier 2: the wiring
# ---------------------------------------------------------------------------
#
# The scanner passing proves nothing about whether a commit is actually
# refused. These cases drive a real `git commit` through a real hook.

echo "WIRING (.husky/commit-msg via a real git commit)"

# new_repo <name> — a disposable repo whose core.hooksPath is a SEPARATE
# directory holding a copy of .husky/commit-msg. That mirrors how this machine
# is really configured: one shared hooks directory serves the main checkout and
# every worktree, so the hook file is never the one on the branch being
# committed. Pointing hooksPath inside the repo would test a layout we do not
# run and would hide the bug this tier exists to catch.
new_repo() {
  repo="$work/$1"
  hooks="$work/$1-hooks"
  mkdir -p "$repo/scripts" "$hooks" || return 1
  cp "$hook" "$hooks/commit-msg" || return 1
  chmod +x "$hooks/commit-msg" || return 1
  git -C "$repo" init -q || return 1
  git -C "$repo" config user.email test@example.invalid || return 1
  git -C "$repo" config user.name "Guard Test" || return 1
  git -C "$repo" config commit.gpgsign false || return 1
  git -C "$repo" config core.hooksPath "$hooks" || return 1
  echo "$repo"
}

repo=$(new_repo blocked) || exit 1
cp "$guard" "$repo/scripts/check-commit-msg.sh"
echo "source line" > "$repo/app.txt"
git -C "$repo" add app.txt scripts/check-commit-msg.sh
cat > "$work/poisoned.txt" <<EOF
fix: an innocent looking subject

SUPABASE_SECRET_KEY=CANARYVALUE9182
EOF
commit_out=$(git -C "$repo" commit -F "$work/poisoned.txt" 2>&1)
commit_rc=$?

if [ "$commit_rc" -ne 0 ]; then
  ok "poisoned message: git commit exits non-zero"
else
  bad "poisoned message: git commit exits non-zero" "commit succeeded"
fi

if git -C "$repo" rev-parse HEAD >/dev/null 2>&1; then
  bad "poisoned message: no commit is created" "HEAD exists"
else
  ok "poisoned message: no commit is created"
fi

# The scanner promises staged work is untouched. If that is false, people learn
# to run with --no-verify and the guard is over.
staged=$(git -C "$repo" diff --cached --name-only | sort | tr '\n' ' ')
if [ "$staged" = "app.txt scripts/check-commit-msg.sh " ]; then
  ok "poisoned message: staged changes are preserved"
else
  bad "poisoned message: staged changes are preserved" "staged: [$staged]"
fi

if echo "$commit_out" | grep -q CANARYVALUE9182; then
  bad "poisoned message: git output does not echo the value" "value appeared in git output"
else
  ok "poisoned message: git output does not echo the value"
fi

# A guard that also blocks good commits gets removed. Prove the happy path.
repo=$(new_repo allowed) || exit 1
cp "$guard" "$repo/scripts/check-commit-msg.sh"
echo "source line" > "$repo/app.txt"
git -C "$repo" add app.txt scripts/check-commit-msg.sh
printf 'fix(cache): honour a `local` flag on the cache entry\n' > "$work/clean.txt"
if git -C "$repo" commit -q -F "$work/clean.txt" >/dev/null 2>&1; then
  ok "clean message: commit succeeds through the hook"
else
  bad "clean message: commit succeeds through the hook" "commit was refused"
fi

# Git runs hooks from the top of the working tree and passes $1 as a path
# relative to it. Committing from a subdirectory is the case that breaks if a
# future edit ever cds or resolves $1 against the caller's cwd.
repo=$(new_repo subdir) || exit 1
cp "$guard" "$repo/scripts/check-commit-msg.sh"
mkdir -p "$repo/packages/api/src"
echo "source line" > "$repo/packages/api/src/app.ts"
git -C "$repo" add .
printf 'fix: committed from a subdirectory\n' > "$work/sub.txt"
if git -C "$repo/packages/api/src" commit -q -F "$work/sub.txt" >/dev/null 2>&1; then
  ok "commit from a subdirectory still runs the guard"
else
  bad "commit from a subdirectory still runs the guard" "commit was refused"
fi

# And it must still BLOCK from a subdirectory — succeeding there could just mean
# the hook silently failed to find the scanner.
repo=$(new_repo subdir-blocked) || exit 1
cp "$guard" "$repo/scripts/check-commit-msg.sh"
mkdir -p "$repo/packages/api/src"
echo "source line" > "$repo/packages/api/src/app.ts"
git -C "$repo" add .
if git -C "$repo/packages/api/src" commit -F "$work/poisoned.txt" >/dev/null 2>&1; then
  bad "poisoned commit from a subdirectory is blocked" "commit succeeded"
else
  ok "poisoned commit from a subdirectory is blocked"
fi

# The branch-predates-the-guard case. core.hooksPath is one shared directory for
# every worktree on the machine, so the moment this hook reaches the main
# checkout it runs for branches that do not carry scripts/check-commit-msg.sh --
# old branches, bisects, tags. Those commits must still go through, and the
# operator must be told the guard is inactive rather than left guessing.
repo=$(new_repo no-scanner) || exit 1
echo "source line" > "$repo/app.txt"
git -C "$repo" add app.txt
printf 'chore: a commit on a branch that predates the guard\n' > "$work/old.txt"
out=$(git -C "$repo" commit -F "$work/old.txt" 2>&1)
if [ $? -eq 0 ]; then
  ok "scanner absent: commit is allowed through"
else
  bad "scanner absent: commit is allowed through" "$(echo "$out" | tr '\n' ' ')"
fi
if echo "$out" | grep -qi "inactive"; then
  ok "scanner absent: operator is warned the guard is inactive"
else
  bad "scanner absent: operator is warned the guard is inactive" "$(echo "$out" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------

echo ""
echo "ran $((pass + fail)) checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
