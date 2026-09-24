#!/bin/sh
# Regression coverage for scripts/db-migrate.sh (apply a migration file to the
# local stack and record it in the ledger under the file's own version) and
# for the table parsing in scripts/migration-status.mjs.
#
# Both run against stub `supabase` and `psql` commands placed first on PATH:
# no Docker, no database. The stub answers `status` with a synthetic DB_URL,
# `migration list` with the same table the real CLI prints (local files of
# the --workdir checkout against a ledger file), and `migration repair` by
# appending to that ledger file, so a second apply sees the row.
#
# What is pinned:
#   - the SQL runs before the ledger row is written, in one transaction
#   - a failed transaction writes no row; a failed row write says how to retry
#   - an already-recorded version is skipped without touching the database
#   - a file outside supabase/migrations, or misnamed, is refused before psql
#   - a stopped stack, or a missing psql, is refused before psql
#   - from a worktree, the stack is asked through the root and the row is
#     written from the worktree that holds the file
#   - `status` counts pending files and rows applied from other checkouts
#   - migration-status.mjs reads the CLI table: a local-only row is pending
#     and exits 10, a remote-only row is not, and a clean ledger exits 0
#
# Usage:  sh scripts/db-migrate.test.sh

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
script="$root/scripts/db-migrate.sh"
status_mjs="$root/scripts/migration-status.mjs"

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

work=$(mktemp -d "${TMPDIR:-/tmp}/db-migrate-test.XXXXXX") || exit 1
# git reports physical paths; keep every expected path physical too.
work=$(cd "$work" && pwd -P) || exit 1
trap 'rm -rf "$work"' EXIT INT TERM

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf 'ok   %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  printf 'FAIL %s: %s\n' "$1" "$2"
}

# --- stubs -----------------------------------------------------------------

mkdir -p "$work/stubs"
cat > "$work/stubs/supabase" <<'STUB'
#!/bin/sh
printf 'supabase %s\n' "$*" >> "$STUB_LOG"
cmd=${1:-}
sub=${2:-}
workdir=.
prev=''
for a in "$@"; do
  [ "$prev" = "--workdir" ] && workdir=$a
  prev=$a
done
case "$cmd $sub" in
  "status "*)
    [ -n "${STUB_NO_STACK:-}" ] && exit 1
    printf 'API_URL="http://127.0.0.1:54321"\nDB_URL="%s"\n' "$STUB_DB_URL"
    exit 0
    ;;
  "migration list")
    printf '\n  \n   Local          | Remote         | Time (UTC)          \n  ----------------|----------------|---------------------\n'
    : > "$STUB_TMP/local"
    for f in "$workdir"/supabase/migrations/*.sql; do
      [ -e "$f" ] || continue
      b=$(basename "$f")
      echo "${b%%_*}" >> "$STUB_TMP/local"
    done
    sort -u "$STUB_TMP/local" -o "$STUB_TMP/local"
    sort -u "$STUB_LEDGER" > "$STUB_TMP/remote"
    sort -u "$STUB_TMP/local" "$STUB_TMP/remote" | while read -r v; do
      l=''
      r=''
      grep -qx "$v" "$STUB_TMP/local" && l=$v
      grep -qx "$v" "$STUB_TMP/remote" && r=$v
      printf '   %-14s | %-14s | %s \n' "$l" "$r" "2026-01-01 00:00:00"
    done
    exit 0
    ;;
  "migration repair")
    [ -n "${STUB_REPAIR_FAIL:-}" ] && {
      echo "repair refused" >&2
      exit 1
    }
    last=''
    for a in "$@"; do last=$a; done
    echo "$last" >> "$STUB_LEDGER"
    echo "Repaired migration history: [$last] => applied"
    exit 0
    ;;
esac
echo "stub supabase: unexpected $*" >&2
exit 99
STUB
cat > "$work/stubs/psql" <<'STUB'
#!/bin/sh
printf 'psql %s\n' "$*" >> "$STUB_LOG"
exit "${STUB_PSQL_RC:-0}"
STUB
chmod +x "$work/stubs/supabase" "$work/stubs/psql"

PATH="$work/stubs:$PATH"
export PATH
STUB_LOG="$work/calls.log"
STUB_LEDGER="$work/ledger.txt"
STUB_TMP="$work"
STUB_DB_URL='postgresql://stub@127.0.0.1:1/stub'
export STUB_LOG STUB_LEDGER STUB_TMP STUB_DB_URL
: > "$STUB_LOG"
: > "$STUB_LEDGER"

# --- fixture repository ----------------------------------------------------

repo="$work/repo"
mkdir -p "$repo/supabase/migrations"
printf 'init\n' > "$work/msg"
(
  cd "$repo" && git init -q -b main &&
    git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg"
) || {
  echo "could not build the fixture repository" >&2
  exit 1
}
mig="$repo/supabase/migrations"
printf 'select 1;\n' > "$mig/20260101000000_one.sql"
printf 'select 2;\n' > "$mig/20260102000000_two.sql"
printf 'select 3;\n' > "$mig/20260103000000_three.sql"
printf 'select 4;\n' > "$mig/20260104000000_four.sql"
printf 'select 0;\n' > "$mig/001_bad.sql"
printf 'select 9;\n' > "$repo/20260109000000_stray.sql"

calls() { cat "$STUB_LOG"; }
reset_log() { : > "$STUB_LOG"; }

# --- usage -----------------------------------------------------------------

out=$(cd "$repo" && sh "$script" 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "no mode is a usage error" || bad "no mode is a usage error" "exit $rc: $out"

out=$(cd "$repo" && sh "$script" apply 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "apply without a file is a usage error" || bad "apply without a file is a usage error" "exit $rc: $out"

out=$(cd "$repo" && sh "$script" frobnicate 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "an unknown mode is a usage error" || bad "an unknown mode is a usage error" "exit $rc: $out"

# --- refusals before psql ---------------------------------------------------

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/001_bad.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'date -u'; then
  ok "a file without the 14-digit version is refused before psql"
else
  bad "a file without the 14-digit version is refused before psql" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$repo" && sh "$script" apply 20260109000000_stray.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'supabase/migrations'; then
  ok "a file outside supabase/migrations is refused before psql"
else
  bad "a file outside supabase/migrations is refused before psql" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260199000000_missing.sql 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && ok "a missing file is refused" || bad "a missing file is refused" "exit $rc: $out"

reset_log
out=$(cd "$repo" && STUB_NO_STACK=1 sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'supabase:local:setup'; then
  ok "a stopped stack is refused before psql, pointing at the setup script"
else
  bad "a stopped stack is refused before psql, pointing at the setup script" "exit $rc: $out"
fi

reset_log
gitdir=$(dirname "$(command -v git)")
mkdir -p "$work/stubs-nopsql"
cp "$work/stubs/supabase" "$work/stubs-nopsql/supabase"
out=$(cd "$repo" && PATH="$work/stubs-nopsql:$gitdir:/usr/bin:/bin" sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'psql not found'; then
  ok "a missing psql is refused with an install hint"
else
  bad "a missing psql is refused with an install hint" "exit $rc: $out"
fi

# --- the happy path ---------------------------------------------------------

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
psql_line=$(calls | grep -n '^psql' | head -1)
repair_line=$(calls | grep -n '^supabase migration repair' | head -1)
if [ "$rc" -eq 0 ] && [ -n "$psql_line" ] && [ -n "$repair_line" ] &&
  [ "${psql_line%%:*}" -lt "${repair_line%%:*}" ]; then
  ok "the SQL runs before the ledger row is written"
else
  bad "the SQL runs before the ledger row is written" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
if echo "$psql_line" | grep -q -- ' -1 ' && echo "$psql_line" | grep -q 'ON_ERROR_STOP=1' &&
  echo "$psql_line" | grep -q -- '-f supabase/migrations/20260101000000_one.sql' && echo "$psql_line" | grep -q "$STUB_DB_URL"; then
  ok "psql runs the file in one transaction, stopping on error, against the stack's DB_URL"
else
  bad "psql runs the file in one transaction, stopping on error, against the stack's DB_URL" "$psql_line"
fi
if echo "$repair_line" | grep -q -- '--status applied 20260101000000' && echo "$repair_line" | grep -q -- "--workdir $repo" &&
  grep -qx 20260101000000 "$STUB_LEDGER" && echo "$out" | grep -q 'recorded 20260101000000_one.sql as 20260101000000'; then
  ok "the row is written under the file's own version"
else
  bad "the row is written under the file's own version" "$repair_line; out: $out"
fi

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && ! calls | grep -q '^psql' && ! calls | grep -q 'repair' && echo "$out" | grep -q 'already recorded'; then
  ok "an already-recorded version is skipped without touching the database"
else
  bad "an already-recorded version is skipped without touching the database" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

# --- failures ---------------------------------------------------------------

reset_log
out=$(cd "$repo" && STUB_PSQL_RC=1 sh "$script" apply supabase/migrations/20260102000000_two.sql 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && ! calls | grep -q 'repair' && ! grep -qx 20260102000000 "$STUB_LEDGER" && echo "$out" | grep -q 'rolled back'; then
  ok "a failed transaction writes no ledger row"
else
  bad "a failed transaction writes no ledger row" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$repo" && STUB_REPAIR_FAIL=1 sh "$script" apply supabase/migrations/20260103000000_three.sql 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && calls | grep -q '^psql' &&
  echo "$out" | grep -q 'supabase migration repair --local --status applied 20260103000000'; then
  ok "a failed row write says the SQL ran and how to record it"
else
  bad "a failed row write says the SQL ran and how to record it" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && STUB_PSQL_RC=1 sh "$script" apply supabase/migrations/20260102000000_two.sql supabase/migrations/20260103000000_three.sql 2>&1)
rc=$?
n=$(calls | grep -c '^psql')
[ "$rc" -eq 1 ] && [ "$n" -eq 2 ] && ok "several files: every file is attempted and any failure fails the run" ||
  bad "several files: every file is attempted and any failure fails the run" "exit $rc, psql calls $n: $out"

# --- from a worktree --------------------------------------------------------

(cd "$repo" && git worktree add -q "$work/wt" -b feature) || bad "fixture worktree" "git worktree add failed"
mkdir -p "$work/wt/supabase/migrations"
cp "$mig/20260104000000_four.sql" "$work/wt/supabase/migrations/"
reset_log
out=$(cd "$work/wt" && sh "$script" apply supabase/migrations/20260104000000_four.sql 2>&1)
rc=$?
status_line=$(calls | grep '^supabase status')
repair_line=$(calls | grep '^supabase migration repair')
if [ "$rc" -eq 0 ] && echo "$status_line" | grep -q -- "--workdir $repo" && echo "$repair_line" | grep -q -- "--workdir $work/wt"; then
  ok "from a worktree: the stack is asked through the root, the row is written from the worktree"
else
  bad "from a worktree: the stack is asked through the root, the row is written from the worktree" "exit $rc: $out; status: $status_line; repair: $repair_line"
fi

# --- status -----------------------------------------------------------------

echo 20260999000000 >> "$STUB_LEDGER"
out=$(cd "$repo" && sh "$script" status 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q '2 recorded, 2 pending in this checkout, 1 applied from another checkout' &&
  echo "$out" | grep -q 'yarn db:migrate supabase/migrations/<file>'; then
  ok "status counts recorded, pending, and rows applied from another checkout"
else
  bad "status counts recorded, pending, and rows applied from another checkout" "exit $rc: $out"
fi

# --- migration-status.mjs reads the same table ------------------------------

out=$(node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 10 ] && echo "$out" | grep -q '2 pending local migrations' && echo "$out" | grep -q '20260102000000' &&
  echo "$out" | grep -q 'yarn db:migrate'; then
  ok "migration-status.mjs: local-only rows are pending, exit 10, with the apply hint"
else
  bad "migration-status.mjs: local-only rows are pending, exit 10, with the apply hint" "exit $rc: $out"
fi

out=$(node "$status_mjs" --local --workdir "$repo" --json 2>&1)
rc=$?
if [ "$rc" -eq 10 ] && echo "$out" | grep -q '"pendingCount":2' && echo "$out" | grep -q '"elsewhereCount":1'; then
  ok "migration-status.mjs --json carries pendingCount and elsewhereCount"
else
  bad "migration-status.mjs --json carries pendingCount and elsewhereCount" "exit $rc: $out"
fi

out=$(node "$status_mjs" --local --workdir "$repo" --warn-only 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok "migration-status.mjs --warn-only exits 0 with pending rows" || bad "migration-status.mjs --warn-only exits 0 with pending rows" "exit $rc: $out"

echo 20260102000000 >> "$STUB_LEDGER"
echo 20260103000000 >> "$STUB_LEDGER"
out=$(node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q 'No pending local migrations' && echo "$out" | grep -q '1 applied from another checkout'; then
  ok "migration-status.mjs: a remote-only row is reported but is not pending"
else
  bad "migration-status.mjs: a remote-only row is reported but is not pending" "exit $rc: $out"
fi

# The unknown state needs the CLI itself to fail, so swap in a stub that does.
nodedir=$(dirname "$(command -v node)")
rm -f "$work/stubs-nopsql/supabase"
printf '#!/bin/sh\necho "connection refused" >&2\nexit 1\n' > "$work/stubs-nopsql/supabase"
chmod +x "$work/stubs-nopsql/supabase"
out=$(cd "$repo" && PATH="$work/stubs-nopsql:$nodedir:$gitdir:/usr/bin:/bin" node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q 'Unable to determine'; then
  ok "migration-status.mjs: a failing CLI is reported as unknown, exit 2"
else
  bad "migration-status.mjs: a failing CLI is reported as unknown, exit 2" "exit $rc: $out"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
