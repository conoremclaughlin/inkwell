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
#
# A function rather than a straight-line block, so the sentinel regressions in
# tier 2 can poison the environment deliberately and call the REAL isolation on
# it. An isolation step that only ever runs on an already-clean environment is
# untestable, and untestable is how the GIT_CONFIG_COUNT hole below survived a
# round of review: the first version of this block cleaned what it had been
# burned by and nothing checked what it had missed.
git_isolate() {
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX \
    GIT_CONFIG GIT_CEILING_DIRECTORIES GIT_TEMPLATE_DIR GIT_INDEX_VERSION 2>/dev/null

  # Command-scope config, which is a separate mechanism from the files above and
  # outranks every one of them — including the repo-local core.hooksPath each
  # fixture sets for itself. Git reads it in two forms and honouring either is
  # enough to hand the suite a hook that is not the one under test:
  #
  #   GIT_CONFIG_COUNT with GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>
  #   GIT_CONFIG_PARAMETERS — git's own transport for `-c`, also read on input
  #
  # In a real environment that substituted hook is a real external program, run
  # by a suite whose entire purpose is to check which hook runs.
  isolate_count=${GIT_CONFIG_COUNT:-0}
  case "$isolate_count" in '' | *[!0-9]*) isolate_count=0 ;; esac
  # Clear the inherited entries and a fixed floor beyond them: the keys outlive
  # the count, so a later GIT_CONFIG_COUNT set by anything else would pick up
  # whatever indices were left behind.
  [ "$isolate_count" -lt 32 ] && isolate_count=32
  isolate_i=0
  while [ "$isolate_i" -lt "$isolate_count" ]; do
    unset "GIT_CONFIG_KEY_$isolate_i" "GIT_CONFIG_VALUE_$isolate_i" 2>/dev/null
    isolate_i=$((isolate_i + 1))
  done
  unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS 2>/dev/null

  GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
}

git_isolate

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

# Checking for the whole canary is too weak to pin this. When the named arm still
# had a value class it matched past the `=`, and `grep -o` reports what it
# matched, so dropping the strip leaked the first character of the secret while
# the whole-value check stayed green. One byte is still disclosure, and a one-byte
# regression is exactly the kind that survives review. Assert the shape instead: a
# reported line is "line N: NAME" and carries no `=` at all. The pattern no longer
# captures value bytes, so this now pins a property the regex and the strip
# uphold together — and it goes red if either of them stops.
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
# every future commit discussing the guard trips it. What makes prose safe is now
# the BARE NAME -- no `=` after it. Two earlier revisions tried to keep the `=`
# writable by exempting the value (first a blacklist of punctuation bytes, then a
# whitelist plus a length floor); both were bypasses, so the assignment form is
# simply refused and prose says the name on its own.
f=$(write_msg bare-name-prose <<'EOF'
docs: explain the guard

A spliced span assigns to JWT_SECRET once it lands, and redacted logs show a
GITHUB_TOKEN with its value starred out. To run locally, set JWT_SECRET in
your env first.
EOF
)
expect_exit 0 "prose naming secret variables without an assignment is allowed" "$f"

# The list shape that was a live false positive on this PR's own commit messages,
# rewritten to bare names. This is the form the docs now ask for, so it is pinned:
# if naming these variables in prose ever stops being possible, every commit that
# discusses the guard is blocked and the guard gets disabled.
f=$(write_msg bare-name-list <<'EOF'
fix: widen the named arm

The boundary excluded underscore, so the arm matched JWT_SECRET but not the
prefixed PCP_JWT_SECRET or MY_GITHUB_TOKEN. Both were allowed; both are closed
now, and a list like GITHUB_TOKEN, JWT_SECRET reads as prose rather than a leak.
EOF
)
expect_exit 0 "a list of bare secret names is allowed" "$f"

# --- the exemptions that are now gone --------------------------------------
#
# Every one of these exited 0 under an earlier value class. They are the reason
# the value constraint was removed rather than refined: each is a shape a real
# credential can take, and each was waved through by a rule calibrated on three
# leaked messages. One case per shape, so a partial regression is still caught.
# Labelled by shape rather than by fixture text, so the suite's own output never
# carries an assignment-shaped line.
for probe in \
  'leading-asterisk:*starsfirst9182' \
  'leading-angle-bracket:<anglefirst9182' \
  'leading-bang:!bangfirst9182' \
  'double-quoted:"doublequoted9182"' \
  "single-quoted:'singlequoted9182'" \
  'unquoted-short:dev' \
  'empty:' \
; do
  label=${probe%%:*}
  value=${probe#*:}
  f=$(printf 'fix: an ordinary subject line\n\nJWT_SECRET=%s\n' "$value" | write_msg "shapeless-$label")
  expect_exit 1 "shapeless value blocked: $label" "$f"
done

# The length floor specifically. A short password or signing key is still a
# credential, and a floor exempts exactly those. Pinned as its own case because
# it is the exemption most likely to look reasonable to a future editor.
f=$(write_msg short-value <<'EOF'
fix: an ordinary subject

SB_TEST_PASSWORD=hunter2
EOF
)
expect_exit 1 "short value is blocked — no length floor" "$f"

f=$(write_msg long-value <<'EOF'
fix: prose naming JWT_SECRET=abcdefghijkl in a sentence
EOF
)
expect_exit 1 "assignment spliced into a sentence is blocked" "$f"

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

# --- report formatting must not be able to clear a detection ----------------
#
# The arms above fault DETECTION. This block faults REPORTING, which is the same
# fail-open shape one layer up and much easier to miss, because the sed and cut
# calls that build the report look cosmetic. They were not: the refusal used to
# be driven by the formatted `hits` string, so faulting any single formatting
# stage emptied the report, and an empty report read as "nothing found" — a
# detected credential exited 0.
#
# Each stage is faulted on its own, via the same delegating-stub technique, so a
# guard restored for one stage and not another is still caught. The assertions
# are: still blocked, still says why, and — the property that makes the fallback
# safe — the synthetic value does NOT appear, because the fallback is a generic
# diagnostic rather than the raw matches.
#
# Stage call order. Named fixture: sed 1 strips values, sed 2 trims the boundary
# byte. Vendor fixture: the named arm finds nothing and runs no sed, so cut 1
# takes the line number and sed 1 labels it.

# fault_tool <tool> <nth-call> <fixture> — stdout+stderr of the guard, exit in $?
fault_tool() {
  tool=$1
  n=$2
  file=$3
  real=$(command -v "$tool")
  bindir="$work/faulttool-$tool-$n"
  mkdir -p "$bindir"
  rm -f "$bindir/count"
  cat > "$bindir/$tool" <<EOF
#!/bin/sh
c=\$(cat "$bindir/count" 2>/dev/null || echo 0)
c=\$((c + 1))
echo "\$c" > "$bindir/count"
[ "\$c" -eq $n ] && exit 2
exec "$real" "\$@"
EOF
  chmod +x "$bindir/$tool"
  PATH="$bindir:$PATH" sh "$guard" "$file" 2>&1
}

named_fixture=$(write_msg format-fault-named <<EOF
fix: something ordinary

SUPABASE_SECRET_KEY=CANARYVALUE9182
EOF
)
vendor_fixture=$(printf 'fix: an ordinary subject line\n\nPasted: ghp_%s\n' "$F36" \
  | write_msg format-fault-vendor)

# Transparency controls. A stub that silently broke everything would make every
# case below "blocked" for the wrong reason, which is the exact failure mode this
# suite keeps rediscovering. Fault a call number the guard never reaches and
# require the ordinary result.
for probe in "sed:named:$named_fixture" "cut:vendor:$vendor_fixture"; do
  tool=${probe%%:*}
  rest=${probe#*:}
  what=${rest%%:*}
  fixture=${rest#*:}
  out=$(fault_tool "$tool" 99 "$fixture")
  rc=$?
  if [ "$rc" -eq 1 ] && echo "$out" | grep -q '^   line '; then
    ok "$tool stub is transparent when not faulting ($what)"
  else
    bad "$tool stub is transparent when not faulting ($what)" \
      "exit $rc: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
  fi
done

for stage in \
  "sed:1:$named_fixture:CANARYVALUE9182:named-report value strip" \
  "sed:2:$named_fixture:CANARYVALUE9182:named-report boundary trim" \
  "cut:1:$vendor_fixture:ghp_$F36:vendor-report line number" \
  "sed:1:$vendor_fixture:ghp_$F36:vendor-report label" \
; do
  tool=$(printf '%s' "$stage" | cut -d: -f1)
  n=$(printf '%s' "$stage" | cut -d: -f2)
  fixture=$(printf '%s' "$stage" | cut -d: -f3)
  secret=$(printf '%s' "$stage" | cut -d: -f4)
  what=$(printf '%s' "$stage" | cut -d: -f5)

  out=$(fault_tool "$tool" "$n" "$fixture")
  rc=$?

  if [ "$rc" -eq 1 ]; then
    ok "$what failure still blocks"
  else
    bad "$what failure still blocks" "exit $rc — a formatting fault cleared a real detection"
  fi

  if echo "$out" | grep -qF "$secret"; then
    bad "$what failure withholds the value" "the synthetic value appeared in the fallback output"
  else
    ok "$what failure withholds the value"
  fi

  # Checking for the synthetic value alone is too weak for the NAMED stages, and
  # mutation is what showed it: a fallback that prints the raw matches leaks
  # nothing there, because the named pattern ends at the `=` and its raw output is
  # already value-free. That property belongs to the regex, not to the fallback,
  # so the check above passes for a reason it is not testing. The shape is the
  # thing to assert — a value-free refusal carries no `=` anywhere — and it goes
  # red for all four stages the moment raw matches are forwarded.
  if echo "$out" | grep -q '='; then
    bad "$what failure forwards no raw match" "an assignment-shaped byte reached the output"
  else
    ok "$what failure forwards no raw match"
  fi

  if echo "$out" | grep -q "could not be formatted"; then
    ok "$what failure says the report was withheld"
  else
    bad "$what failure says the report was withheld" "$(echo "$out" | tr '\n' ' ' | cut -c1-160)"
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

# --- the environment this suite refuses to inherit --------------------------
#
# Everything above assumes the fixtures' own git config is the config git uses.
# Three inherited inputs break that assumption, and each has a sentinel here
# because git_isolate is otherwise a block of unsets that nothing exercises.
#
# Each case is a CONTROL and then the regression. The control poisons the
# environment and shows the injection really does take effect — without it,
# "the sentinel was not touched" is equally the result of a misspelled variable
# name, and the regression would pass while testing nothing. That is the shape of
# false comfort this suite has been caught by before, so the control runs first
# and its absence would be the bug.

sentinel_hooks="$work/inherited-hooks"
mkdir -p "$sentinel_hooks"
sentinel_flag="$work/inherited-hook-fired"
cat > "$sentinel_hooks/commit-msg" <<EOF
#!/bin/sh
echo fired > "$sentinel_flag"
exit 0
EOF
chmod +x "$sentinel_hooks/commit-msg"

# sentinel_commit <name> — a fresh provider/repo pair whose own core.hooksPath is
# the real hook, then one attempt at the poisoned message; git's output on stdout.
# The flag file is the evidence: it exists only if some OTHER hook ran instead.
sentinel_commit() {
  new_provider "$work/$1-provider" || return 1
  new_repo "$work/$1" "$work/$1-provider/.husky" || return 1
  rm -f "$sentinel_flag"
  git -C "$work/$1" commit -F "$work/poisoned.txt" 2>&1
}

# sentinel_control <label> — the injection must beat the repo-local hooksPath.
sentinel_control() {
  if [ -f "$sentinel_flag" ]; then
    ok "$1: control — injected hooksPath really does take effect"
  else
    bad "$1: control — injected hooksPath really does take effect" \
      "sentinel never fired, so the regression below would prove nothing"
  fi
}

# sentinel_isolated <label> <git-output> — after git_isolate, the real hook runs.
sentinel_isolated() {
  if [ -f "$sentinel_flag" ]; then
    bad "$1: cleared before any git operation" "the inherited hook ran"
  else
    ok "$1: cleared before any git operation"
  fi
  if echo "$2" | grep -qF "$SCAN_MARKER"; then
    ok "$1: the hook under test is the one that ran"
  else
    bad "$1: the hook under test is the one that ran" "$(echo "$2" | tr '\n' ' ' | cut -c1-160)"
  fi
}

# --- form 1: GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n -------
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0="$sentinel_hooks"
export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0

sentinel_commit count-control >/dev/null
sentinel_control "GIT_CONFIG_COUNT"

git_isolate
out=$(sentinel_commit count-isolated)
sentinel_isolated "GIT_CONFIG_COUNT" "$out"

# --- form 2: GIT_CONFIG_PARAMETERS ------------------------------------------
GIT_CONFIG_PARAMETERS="'core.hooksPath'='$sentinel_hooks'"
export GIT_CONFIG_PARAMETERS

sentinel_commit params-control >/dev/null
sentinel_control "GIT_CONFIG_PARAMETERS"

git_isolate
out=$(sentinel_commit params-isolated)
sentinel_isolated "GIT_CONFIG_PARAMETERS" "$out"

# --- form 3: GIT_INDEX_FILE --------------------------------------------------
# Not a hook substitution but the same class of inheritance, and the one with the
# worst consequence: git exports it to every hook it runs, so a suite invoked
# from a commit hook would stage its fixtures into the REAL repository's index.
# The sentinel is a file git must never write.
#
# The sentinel is a path git must never create. A path rather than a file with
# known contents, because git reads an existing index before writing one and
# refuses outright on a bad signature — which leaves the file untouched for a
# reason that has nothing to do with isolation, and a control that fails for that
# reason is how this check was written the first time.
sentinel_index="$work/inherited-index"
rm -f "$sentinel_index"
GIT_INDEX_FILE="$sentinel_index"
export GIT_INDEX_FILE

mkdir -p "$work/index-control"
git -C "$work/index-control" init -q
git -C "$work/index-control" config user.email test@example.invalid
git -C "$work/index-control" config user.name "Guard Test"
echo "source line" > "$work/index-control/app.txt"
git -C "$work/index-control" add app.txt >/dev/null 2>&1
if [ -f "$sentinel_index" ]; then
  ok "GIT_INDEX_FILE: control — an inherited index really is the one git writes"
else
  bad "GIT_INDEX_FILE: control — an inherited index really is the one git writes" \
    "git ignored it, so the regression below would prove nothing"
fi

rm -f "$sentinel_index"
git_isolate
new_provider "$work/index-isolated-provider"
new_repo "$work/index-isolated" "$work/index-isolated-provider/.husky"
git -C "$work/index-isolated" commit -F "$work/poisoned.txt" >/dev/null 2>&1
if [ -f "$sentinel_index" ]; then
  bad "GIT_INDEX_FILE: cleared, so the inherited index is untouched" \
    "the supplied index was written"
else
  ok "GIT_INDEX_FILE: cleared, so the inherited index is untouched"
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

# --- known-prose classification ---------------------------------------------
#
# The runner carries a full-SHA list of commits the scanner flags that were read
# and found to hold no credential — prose about this guard that writes an
# assignment. It classifies a refusal; it does not suppress one. Three things
# have to hold, and the third is the one that decides whether the list is an
# audit record or a mute button:
#
#   a listed commit is reported as known prose and the sweep passes
#   an unlisted flagged commit still fails, in the same run as a listed one
#   a scan ERROR on a listed commit still fails — a pin speaks for a message
#   that was read, and a scanner that did not complete has read nothing
#
# The fixture pins a synthetic SHA into its own copy of the runner, so nothing
# here depends on this repository's history.

# pin_known_prose <repo> <sha>... — rewrite the fixture copy's pin list.
pin_known_prose() {
  repo=$1
  shift
  runner="$repo/scripts/check-commit-msg.history.sh"
  sed "s|^KNOWN_PROSE=.*|KNOWN_PROSE=\"$*\"|" "$runner" > "$runner.new" || return 1
  mv "$runner.new" "$runner" || return 1
  # Loud if the rewrite missed: a silent no-op here would leave every check
  # below testing the unpinned path while claiming to test the pinned one.
  grep -q "^KNOWN_PROSE=\"$*\"\$" "$runner"
}

# add_history_commit <dir> <subject> — one more commit on origin/main.
history_seq=0
add_history_commit() {
  history_seq=$((history_seq + 1))
  echo "line $history_seq" >> "$1/app.txt" || return 1
  git -C "$1" add app.txt || return 1
  printf '%s\n' "$2" > "$work/history-subject.txt" || return 1
  git -C "$1" commit -q --no-verify -F "$work/history-subject.txt" || return 1
  git -C "$1" update-ref refs/remotes/origin/main HEAD || return 1
}

new_history_repo "$work/history-known" "JWT_SECRET=$HISTORY_CANARY"
known_sha=$(git -C "$work/history-known" rev-parse HEAD)
if pin_known_prose "$work/history-known" "$known_sha"; then
  ok "the pin rewrite landed in the runner under test"
else
  bad "the pin rewrite landed in the runner under test" "KNOWN_PROSE was not replaced"
fi

known_out=$(cd "$work/history-known" && sh scripts/check-commit-msg.history.sh 10 2>&1)
known_rc=$?
if [ "$known_rc" -eq 0 ] && echo "$known_out" | grep -q "known prose"; then
  ok "a pinned flagged commit is classified as known prose and the sweep passes"
else
  bad "a pinned flagged commit is classified as known prose and the sweep passes" \
    "exit $known_rc: $(echo "$known_out" | tr '\n' ' ' | cut -c1-200)"
fi
if echo "$known_out" | grep -q "unexpected 0"; then
  ok "a pinned commit is reported separately from unexpected findings"
else
  bad "a pinned commit is reported separately from unexpected findings" \
    "$(echo "$known_out" | tr '\n' ' ' | cut -c1-200)"
fi
# Classification is not a licence to print. The known path names a flagged commit
# too, so it is the same disclosure surface as the failure path.
if echo "$known_out" | grep -q "$HISTORY_CANARY"; then
  bad "the known-prose path prints no message content" "the synthetic canary reached the output"
else
  ok "the known-prose path prints no message content"
fi

# An unlisted flagged commit, in the same sweep as the listed one. Together they
# pin that the list classifies the commit it names and nothing else.
add_history_commit "$work/history-known" "GITHUB_TOKEN=$HISTORY_CANARY"
unlisted_sha=$(git -C "$work/history-known" rev-parse HEAD)
mixed_out=$(cd "$work/history-known" && sh scripts/check-commit-msg.history.sh 10 2>&1)
mixed_rc=$?
if [ "$mixed_rc" -ne 0 ] && echo "$mixed_out" | grep -q "unexpected 1"; then
  ok "an unlisted flagged commit still fails the sweep"
else
  bad "an unlisted flagged commit still fails the sweep" \
    "exit $mixed_rc: $(echo "$mixed_out" | tr '\n' ' ' | cut -c1-200)"
fi
if echo "$mixed_out" | grep -q "$unlisted_sha"; then
  ok "the unlisted commit is named by SHA"
else
  bad "the unlisted commit is named by SHA" "$(echo "$mixed_out" | tr '\n' ' ' | cut -c1-200)"
fi
if echo "$mixed_out" | grep -q "$HISTORY_CANARY"; then
  bad "a mixed sweep prints no message content" "the synthetic canary reached the output"
else
  ok "a mixed sweep prints no message content"
fi

# The property that keeps the list an audit record. Same repo shape, same pin,
# but the scanner cannot complete: a pin must not convert that into success.
new_history_repo "$work/history-pin-error" "JWT_SECRET=$HISTORY_CANARY"
pin_error_sha=$(git -C "$work/history-pin-error" rev-parse HEAD)
pin_known_prose "$work/history-pin-error" "$pin_error_sha" || \
  bad "pin rewrite for the scan-error case" "KNOWN_PROSE was not replaced"
printf '#!/bin/sh\nexit 2\n' > "$work/history-pin-error/scripts/check-commit-msg.sh"
pin_error_out=$(cd "$work/history-pin-error" && sh scripts/check-commit-msg.history.sh 10 2>&1)
pin_error_rc=$?
if [ "$pin_error_rc" -ne 0 ] && echo "$pin_error_out" | grep -q "scan did not complete"; then
  ok "a scan error on a pinned commit fails rather than passing as known prose"
else
  bad "a scan error on a pinned commit fails rather than passing as known prose" \
    "exit $pin_error_rc: $(echo "$pin_error_out" | tr '\n' ' ' | cut -c1-200)"
fi
if echo "$pin_error_out" | grep -q "known prose"; then
  bad "a scan error is not classified" "the pin absorbed an operational error"
else
  ok "a scan error is not classified"
fi

# The one result that is allowed to pass without sweeping anything, pinned so it
# stays the only one. This runner is local-only by design, so a clone with no
# origin/main genuinely has nothing to sweep — but "the sweep did not run" used to
# be indistinguishable from "rev-list failed", because rev-list's status was
# discarded and an empty list fell through to the same SKIP.
new_history_repo "$work/history-noref" "fix: an entirely ordinary subject line"
git -C "$work/history-noref" update-ref -d refs/remotes/origin/main
noref_out=$(cd "$work/history-noref" && sh scripts/check-commit-msg.history.sh 10 2>&1)
noref_rc=$?
if [ "$noref_rc" -eq 0 ] && echo "$noref_out" | grep -q "SKIP no origin/main"; then
  ok "a clone with no origin/main skips the sweep and says which reason"
else
  bad "a clone with no origin/main skips the sweep and says which reason" \
    "exit $noref_rc: $(echo "$noref_out" | tr '\n' ' ' | cut -c1-200)"
fi

# The other side of it, and the case that pins the difference. origin/main
# resolves — so there IS something to sweep and the SKIP above is not available —
# but the walk yields no commits. The ref is pointed at a tree, which resolves as
# an object and produces an empty walk.
#
# Zero commits swept must not print as zero findings. That is the same fail-open
# shape as everything else in this file: nothing was checked, and "nothing was
# checked" reads identically to "nothing was found" unless something says so.
#
# One honest gap: rev-list's own non-zero status is handled and is NOT exercised
# here. This fixture reaches the empty-walk guard instead, and I could not induce
# a genuine rev-list failure on a ref that rev-parse --verify still accepts. The
# status check is defensive; the guard below is the one under test.
new_history_repo "$work/history-badref" "fix: an entirely ordinary subject line"
git -C "$work/history-badref" update-ref refs/remotes/origin/main \
  "$(git -C "$work/history-badref" rev-parse 'HEAD^{tree}')"
badref_out=$(cd "$work/history-badref" && sh scripts/check-commit-msg.history.sh 10 2>&1)
badref_rc=$?
if [ "$badref_rc" -ne 0 ] && echo "$badref_out" | grep -q "nothing was swept"; then
  ok "a resolved ref that sweeps nothing fails rather than passing as clean"
else
  bad "a resolved ref that sweeps nothing fails rather than passing as clean" \
    "exit $badref_rc: $(echo "$badref_out" | tr '\n' ' ' | cut -c1-200)"
fi

echo ""
echo "ran $((pass + fail)) checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
exit 0
