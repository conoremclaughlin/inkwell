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
guard="${GUARD_UNDER_TEST:-$root/scripts/check-commit-msg.sh}"
hook="${HOOK_UNDER_TEST:-$root/.husky/commit-msg}"

# The two overrides exist so the suite can be pointed at a deliberately broken
# copy and checked for going red. A test tier that cannot fail is not evidence,
# and this one has been in that state before: an earlier harness built fixtures
# the hook could never resolve, so every rejection case passed without anything
# being scanned. Mutating .husky/commit-msg is also the only way to exercise it
# from a worktree where that path is permission-gated.

# Isolate every git operation below from the environment this suite inherits.
#
# This matters more than it looks. The suite is meant to run from a commit hook's
# neighbourhood and from CI, and git exports GIT_DIR, GIT_INDEX_FILE and
# GIT_WORK_TREE to the hooks it runs — so a disposable repo created underneath one
# would quietly operate on the REAL repository's index instead of its own, and the
# wiring tier would be reporting on something it did not build. A global
# core.hooksPath or init.templateDir does the same thing to the hook itself,
# supplying a different hook than the one under test.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX \
  GIT_CONFIG GIT_CEILING_DIRECTORIES GIT_TEMPLATE_DIR GIT_INDEX_VERSION 2>/dev/null
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM

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

# A quoted value is the bypass the first-byte blacklist left open: a value class
# that only admits credential bytes rejects its own opening quote and the whole
# assignment reads through. Both quote styles, because a dump may emit either.
f=$(write_msg quoted-double <<'EOF'
fix: an ordinary subject

JWT_SECRET="s3cretvaluehere"
EOF
)
expect_exit 1 "double-quoted secret value is blocked" "$f"

f=$(write_msg quoted-single <<'EOF'
fix: an ordinary subject

JWT_SECRET='s3cretvaluehere'
EOF
)
expect_exit 1 "single-quoted secret value is blocked" "$f"

# What separates a secret from prose here is a run of credential-shaped bytes,
# not the punctuation we happen to have been bitten by. That makes the rule a
# length threshold, and a threshold has a documented floor: below it the named
# arm does not fire and the dump arm and vendor shapes are what remain. Pinned
# so the floor cannot drift without a failing test.
f=$(write_msg short-value <<'EOF'
fix: prose naming a short default like JWT_SECRET=dev in a sentence
EOF
)
expect_exit 0 "value shorter than the credential-run floor is allowed" "$f"

f=$(write_msg long-value <<'EOF'
fix: prose naming JWT_SECRET=abcdefghijkl in a sentence
EOF
)
expect_exit 1 "value at or above the credential-run floor is blocked" "$f"

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

# A scan that did not complete must not read as a scan that found nothing.
# grep exits >=2 on error; collapsing that into "no match" fails OPEN exactly
# when the guard is malfunctioning. An unreadable regular file gets past the
# -f check at the top and reaches grep, which is the cheapest way to drive a
# real grep error rather than a simulated one.
unreadable="$work/unreadable.msg"
printf 'fix: an entirely clean message\n' > "$unreadable"
chmod 000 "$unreadable"
out=$(sh "$guard" "$unreadable" 2>&1)
got=$?
chmod 644 "$unreadable"
if [ "$got" -eq 2 ]; then
  ok "unreadable message file fails closed (exit 2)"
else
  bad "unreadable message file fails closed (exit 2)" "got $got — a failed scan passed as clean"
fi
if echo "$out" | grep -q "scan did not complete"; then
  ok "failed scan says so, rather than reporting a clean result"
else
  bad "failed scan says so, rather than reporting a clean result" "$(echo "$out" | tr '\n' ' ')"
fi

# The unreadable-file case above breaks EVERY scan at once, so it passes as long
# as any one arm still guards -- it cannot tell which. Removing the guard from a
# single arm leaves it green, which is the "passes for the wrong reason" shape
# this suite exists to avoid. So fault one grep invocation at a time, via a stub
# on PATH that delegates to the real grep except on its Nth call. The code under
# test is the real script; only the external tool it depends on is faulted, which
# is exactly the failure being guarded against.
#
# Call order for a clean message: 1 named, 2 vendor shapes, 3 dump count.
REAL_GREP=$(command -v grep)
clean_for_fault="$work/clean-for-fault.msg"
printf 'fix: an entirely clean message\n' > "$clean_for_fault"

fault_grep() {
  n=$1
  bindir="$work/faultbin$n"
  mkdir -p "$bindir"
  rm -f "$bindir/count"
  cat > "$bindir/grep" <<EOF
#!/bin/sh
c=\$(cat "$bindir/count" 2>/dev/null || echo 0)
c=\$((c + 1))
echo "\$c" > "$bindir/count"
[ "\$c" -eq $n ] && exit 2
exec "$REAL_GREP" "\$@"
EOF
  chmod +x "$bindir/grep"
  PATH="$bindir:$PATH" sh "$guard" "$clean_for_fault" >/dev/null 2>&1
}

# Sanity: the stub must be transparent when it is not faulting, or a "blocked"
# result below would just mean the harness broke.
fault_grep 99
if [ $? -eq 0 ]; then
  ok "grep stub is transparent when not faulting"
else
  bad "grep stub is transparent when not faulting" "clean message did not pass through the stub"
fi

for arm in "1:named-variable" "2:vendor-shape" "3:dump-count"; do
  n=${arm%%:*}
  what=${arm#*:}
  fault_grep "$n"
  rc=$?
  if [ "$rc" -eq 2 ]; then
    ok "$what scan failure fails closed"
  else
    bad "$what scan failure fails closed" "exit $rc — this arm's error passed as a clean result"
  fi
done

# ---------------------------------------------------------------------------
# Tier 2: the wiring
# ---------------------------------------------------------------------------
#
# The scanner passing proves nothing about whether a commit is actually refused.
# These cases drive a real `git commit` through the real hook.
#
# THE LAYOUT MATTERS, and getting it wrong is how this tier fooled itself once
# already. `core.hooksPath` on this machine is one shared directory serving the
# main checkout and every worktree, so the hook file is never the one on the
# branch being committed. The hook resolves its scanner as
# "$(dirname "$0")/../scripts/check-commit-msg.sh" -- i.e. beside itself, in the
# checkout that PROVIDES the hook, not in the worktree that invokes it.
#
# So every fixture is two separate trees:
#
#   <name>-provider/          the checkout that owns core.hooksPath
#     .husky/commit-msg       the hook under test
#     scripts/check-commit-msg.sh
#   <name>/                   the invoking repo -- deliberately has NO scripts/,
#                             which is what an older branch looks like
#
# An earlier version of this file created the hooks directory with no sibling
# scripts/, so the hook could never find a scanner and EVERY wiring case took the
# missing-provider branch. The rejection cases still passed -- because nothing was
# scanned, not because scanning worked. That is why each rejection below also
# asserts the scanner's own marker, and the missing-provider cases assert the
# hook's distinct diagnostic. "Refused" on its own cannot tell a working guard
# from a dead one.

echo "WIRING (.husky/commit-msg via a real git commit)"

SCAN_MARKER="looks like it contains credentials"
PROVIDER_MARKER="missing its readable credential scanner"

# new_provider <dir> — a checkout that owns the hook and the scanner.
new_provider() {
  mkdir -p "$1/.husky" "$1/scripts" || return 1
  cp "$hook" "$1/.husky/commit-msg" || return 1
  chmod 755 "$1/.husky/commit-msg" || return 1
  cp "$guard" "$1/scripts/check-commit-msg.sh" || return 1
}

# new_repo <dir> <hooks-path> — an invoking repo with no scanner of its own.
new_repo() {
  mkdir -p "$1" || return 1
  git -C "$1" init -q || return 1
  git -C "$1" config user.email test@example.invalid || return 1
  git -C "$1" config user.name "Guard Test" || return 1
  git -C "$1" config commit.gpgsign false || return 1
  git -C "$1" config core.hooksPath "$2" || return 1
  echo "source line" > "$1/app.txt" || return 1
  git -C "$1" add app.txt || return 1
}

cat > "$work/clean.txt" <<'EOF'
fix(cache): honour a `local` flag on the cache entry
EOF

cat > "$work/poisoned.txt" <<'EOF'
fix: an innocent looking subject

SUPABASE_SECRET_KEY=CANARYVALUE9182
EOF

# expect_clean <label> <repo> [commit-dir]
expect_clean() {
  label=$1
  repo=$2
  dir=${3:-$2}
  out=$(git -C "$dir" commit -F "$work/clean.txt" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && git -C "$repo" rev-parse HEAD >/dev/null 2>&1; then
    ok "$label"
  else
    bad "$label" "exit $rc: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
  fi
}

# expect_blocked <label> <repo> <marker> [commit-dir]
# Asserts, for every rejection: non-zero through git, the RIGHT diagnostic (so a
# dead hook cannot masquerade as a working one), no commit created, the index
# preserved, and no synthetic value anywhere in the output.
expect_blocked() {
  label=$1
  repo=$2
  marker=$3
  dir=${4:-$2}
  before=$(git -C "$repo" diff --cached --name-only | sort | tr '\n' ' ')
  out=$(git -C "$dir" commit -F "$work/poisoned.txt" 2>&1)
  rc=$?
  after=$(git -C "$repo" diff --cached --name-only | sort | tr '\n' ' ')

  if [ "$rc" -eq 0 ]; then
    bad "$label: refused" "git commit succeeded"
  else
    ok "$label: refused"
  fi

  if echo "$out" | grep -qF "$marker"; then
    ok "$label: refused by the expected path"
  else
    bad "$label: refused by the expected path" "no [$marker] in: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
  fi

  if git -C "$repo" rev-parse HEAD >/dev/null 2>&1; then
    bad "$label: no commit created" "HEAD exists"
  else
    ok "$label: no commit created"
  fi

  if [ "$before" = "$after" ]; then
    ok "$label: index preserved"
  else
    bad "$label: index preserved" "[$before] -> [$after]"
  fi

  if echo "$out" | grep -q CANARYVALUE9182; then
    bad "$label: value not echoed" "the synthetic value appeared in git output"
  else
    ok "$label: value not echoed"
  fi
}

# --- the case this wrapper exists for: an older invoking checkout -----------
# The invoking repo has no scripts/ at all. Under the old --show-toplevel hook
# this could not work; under provider-relative resolution it borrows the
# provider's scanner, which is the whole point of the change.

new_provider "$work/old-clean-provider"
new_repo "$work/old-clean" "$work/old-clean-provider/.husky"
expect_clean "older invoking checkout, clean message" "$work/old-clean"

new_provider "$work/old-poison-provider"
new_repo "$work/old-poison" "$work/old-poison-provider/.husky"
expect_blocked "older invoking checkout, poisoned message" "$work/old-poison" "$SCAN_MARKER"

# --- a path containing spaces ----------------------------------------------
new_provider "$work/sp ace provider"
new_repo "$work/sp ace repo" "$work/sp ace provider/.husky"
expect_clean "provider path with spaces, clean message" "$work/sp ace repo"

new_provider "$work/sp ace provider2"
new_repo "$work/sp ace repo2" "$work/sp ace provider2/.husky"
expect_blocked "provider path with spaces, poisoned message" "$work/sp ace repo2" "$SCAN_MARKER"

# --- a RELATIVE hooksPath ---------------------------------------------------
# Git resolves a relative core.hooksPath against the top of the working tree, so
# this is the ordinary in-repo `.husky` arrangement rather than the shared one.
new_provider "$work/relative"
git -C "$work/relative" init -q
git -C "$work/relative" config user.email test@example.invalid
git -C "$work/relative" config user.name "Guard Test"
git -C "$work/relative" config commit.gpgsign false
git -C "$work/relative" config core.hooksPath .husky
echo "source line" > "$work/relative/app.txt"
git -C "$work/relative" add app.txt scripts/check-commit-msg.sh
expect_blocked "relative hooksPath, poisoned message" "$work/relative" "$SCAN_MARKER"
expect_clean "relative hooksPath, clean message" "$work/relative"

# --- committing from a subdirectory ----------------------------------------
# Git runs hooks from the top of the working tree and passes $1 relative to it.
# This is the case that breaks if anything ever resolves $1 against the caller.
new_provider "$work/subdir-provider"
new_repo "$work/subdir" "$work/subdir-provider/.husky"
mkdir -p "$work/subdir/packages/api/src"
echo "source line" > "$work/subdir/packages/api/src/app.ts"
git -C "$work/subdir" add packages/api/src/app.ts
expect_blocked "commit from a subdirectory" "$work/subdir" "$SCAN_MARKER" "$work/subdir/packages/api/src"
expect_clean "commit from a subdirectory, clean message" "$work/subdir" "$work/subdir/packages/api/src"

# --- a broken provider ------------------------------------------------------
# With provider-relative resolution, "no scanner" no longer means "old branch" --
# it means the checkout that owns core.hooksPath is broken. That must block, and
# say so distinctly enough to tell it apart from a credential hit.

new_provider "$work/noscanner-provider"
rm -f "$work/noscanner-provider/scripts/check-commit-msg.sh"
new_repo "$work/noscanner" "$work/noscanner-provider/.husky"
out=$(git -C "$work/noscanner" commit -F "$work/clean.txt" 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "provider missing its scanner: blocks even a clean message"
else
  bad "provider missing its scanner: blocks even a clean message" "commit succeeded with no scanner"
fi
if echo "$out" | grep -qF "$PROVIDER_MARKER"; then
  ok "provider missing its scanner: distinct diagnostic, not a credential report"
else
  bad "provider missing its scanner: distinct diagnostic, not a credential report" "$(echo "$out" | tr '\n' ' ' | cut -c1-160)"
fi
if echo "$out" | grep -qF "$SCAN_MARKER"; then
  bad "provider missing its scanner: not reported as a credential hit" "claimed credentials were found"
else
  ok "provider missing its scanner: not reported as a credential hit"
fi

new_provider "$work/unreadable-provider"
chmod 000 "$work/unreadable-provider/scripts/check-commit-msg.sh"
new_repo "$work/unreadable" "$work/unreadable-provider/.husky"
out=$(git -C "$work/unreadable" commit -F "$work/clean.txt" 2>&1)
rc=$?
chmod 644 "$work/unreadable-provider/scripts/check-commit-msg.sh"
if [ "$rc" -ne 0 ] && echo "$out" | grep -qF "$PROVIDER_MARKER"; then
  ok "provider scanner unreadable: blocks with the provider diagnostic"
else
  bad "provider scanner unreadable: blocks with the provider diagnostic" "exit $rc: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
fi

# Git maps any non-zero hook status onto commit exit 1, so the hook's own exit 2
# is only observable by invoking it directly. Pinned both ways so neither is
# asserted in the wrong place.
out=$(cd "$work/noscanner" && sh "$work/noscanner-provider/.husky/commit-msg" "$work/clean.txt" 2>&1)
rc=$?
if [ "$rc" -eq 2 ]; then
  ok "hook invoked directly with a broken provider exits 2"
else
  bad "hook invoked directly with a broken provider exits 2" "got $rc"
fi
# ---------------------------------------------------------------------------
# Tier 3: the history runner's output
# ---------------------------------------------------------------------------
#
# scripts/check-commit-msg.history.sh reads real commit messages, so what it
# PRINTS is a disclosure surface of its own. Every commit it names is one the
# scanner flagged, which means any context it shows alongside the SHA may be a
# live credential. It printed 60 characters of the subject line until this tier
# existed, and a credential spliced by a shell substitution lands wherever the
# cursor was -- line one included.
#
# The fixture is a repo of our own making with a synthetic canary in the SUBJECT.
# No real history is read: the runner sweeps origin/main, so the fixture creates
# that ref locally.

echo "HISTORY RUNNER (scripts/check-commit-msg.history.sh)"

history_runner="${HISTORY_UNDER_TEST:-$root/scripts/check-commit-msg.history.sh}"
HISTORY_CANARY=HISTORYCANARY9182

# new_history_repo <dir> <subject> — one commit, reachable as origin/main.
new_history_repo() {
  mkdir -p "$1/scripts" || return 1
  git -C "$1" init -q || return 1
  git -C "$1" config user.email test@example.invalid || return 1
  git -C "$1" config user.name "Guard Test" || return 1
  git -C "$1" config commit.gpgsign false || return 1
  cp "$guard" "$1/scripts/check-commit-msg.sh" || return 1
  cp "$history_runner" "$1/scripts/check-commit-msg.history.sh" || return 1
  echo "source line" > "$1/app.txt" || return 1
  git -C "$1" add app.txt scripts || return 1
  printf '%s\n' "$2" > "$work/history-subject.txt" || return 1
  git -C "$1" commit -q --no-verify -F "$work/history-subject.txt" || return 1
  git -C "$1" update-ref refs/remotes/origin/main HEAD || return 1
}

# The control comes first. "The canary did not appear" is worth nothing if the
# sweep never ran -- an empty output passes that check trivially, which is the
# shape of false comfort this suite has already been caught by twice. So prove
# the runner sweeps and reports on a repo of this construction before asking it
# to stay quiet about one.
new_history_repo "$work/history-clean" "fix: an entirely ordinary subject line"
clean_out=$(cd "$work/history-clean" && sh scripts/check-commit-msg.history.sh 10 2>&1)
clean_rc=$?
if [ "$clean_rc" -eq 0 ] && echo "$clean_out" | grep -q "swept 1, flagged 0"; then
  ok "history runner sweeps a synthetic repo and reports it clean"
else
  bad "history runner sweeps a synthetic repo and reports it clean" \
    "exit $clean_rc: $(echo "$clean_out" | tr '\n' ' ' | cut -c1-200)"
fi

new_history_repo "$work/history-leak" "JWT_SECRET=$HISTORY_CANARY"
leak_sha=$(git -C "$work/history-leak" rev-parse HEAD)
leak_out=$(cd "$work/history-leak" && sh scripts/check-commit-msg.history.sh 10 2>&1)
leak_rc=$?

# Discrimination first: the runner must actually have flagged this commit. If it
# did not, the disclosure check below is vacuous.
if [ "$leak_rc" -ne 0 ] && echo "$leak_out" | grep -q "flagged 1"; then
  ok "history runner flags a commit whose subject is a secret assignment"
else
  bad "history runner flags a commit whose subject is a secret assignment" \
    "exit $leak_rc: $(echo "$leak_out" | tr '\n' ' ' | cut -c1-200)"
fi

if echo "$leak_out" | grep -q "$leak_sha"; then
  ok "history runner names the flagged commit by SHA"
else
  bad "history runner names the flagged commit by SHA" \
    "$(echo "$leak_out" | tr '\n' ' ' | cut -c1-200)"
fi

# The property itself. Checked against the canary AND against the assignment
# shape, because a future report that printed only "JWT_SECRET=" would still be
# echoing the flagged message back out.
if echo "$leak_out" | grep -q "$HISTORY_CANARY"; then
  bad "history runner does not print the flagged message" "the synthetic canary reached the output"
else
  ok "history runner does not print the flagged message"
fi

if echo "$leak_out" | grep -q 'JWT_SECRET'; then
  bad "history runner does not echo the flagged subject line" "flagged subject text reached the output"
else
  ok "history runner does not echo the flagged subject line"
fi

echo ""
echo "ran $((pass + fail)) checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
