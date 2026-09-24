#!/bin/sh
# Regression coverage for scripts/db-migrate.sh (apply a migration file to the
# local stack and record it in the ledger under the file's own version) and
# for the table parsing in scripts/migration-status.mjs.
#
# Hermetic: PATH is a directory of stub `supabase` and `psql` commands plus a
# directory of symlinks to the few utilities the scripts need. No Docker, no
# database, and nothing from the host's system directories, so a psql that
# happens to be installed on a CI runner cannot leak in.
#
# The supabase stub answers `status` with a synthetic DB_URL and `migration
# list` with the same table the real CLI prints (local files of the --workdir
# checkout against a ledger file). The psql stub records its argv, keeps a
# copy of the SQL it was handed, answers the recorded-count query from the
# ledger file, and appends the version it was given on a successful apply,
# standing in for the INSERT.
#
# What is pinned:
#   - the ledger row and the file run in ONE psql transaction, behind an
#     advisory lock on the version, with values passed as psql variables
#   - a failed transaction writes no row
#   - an already-recorded version is skipped without an apply
#   - a recorded-count read that fails is a refusal, never "not recorded"
#   - every database call uses the root stack's DB_URL; a worktree's own
#     supabase/config.toml is never consulted, however divergent
#   - a file outside supabase/migrations, misnamed, or carrying its own
#     BEGIN/COMMIT is refused before psql
#   - a stopped stack, or a missing psql, is refused before psql; the hint
#     names `supabase start`, never the setup script that resets the database
#   - `status` counts pending files and rows applied from other checkouts
#   - migration-status.mjs reads the CLI table: a local-only row is pending
#     (exit 10), a remote-only row is not, a valid empty table is clean,
#     output without the table header is unknown (exit 2), and the apply
#     hint follows the target
#
#   - transaction control is judged SQL-aware: every spelling at the top
#     level is refused, and comments, strings and dollar-quoted bodies are
#     not; psql meta-commands and BEGIN ATOMIC are refused
#   - no message ever prints the connection string, in any of its forms
#   - the integration harness's own refusals: a failed CREATE DATABASE issues
#     no DROP, and a connection that reports another database stops before DDL
#
# Usage:  sh scripts/db-migrate.test.sh
#
# SCRIPT_UNDER_TEST and STATUS_UNDER_TEST point the suite at other copies of
# the two scripts, so a check can be shown red against an older head.

set -u

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
script="${SCRIPT_UNDER_TEST:-$root/scripts/db-migrate.sh}"
status_mjs="${STATUS_UNDER_TEST:-$root/scripts/migration-status.mjs}"
itest="$root/scripts/db-migrate.integration.test.sh"
guard="$root/scripts/lib/sql-transaction-control.awk"

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

# --- a hermetic PATH ------------------------------------------------------

# Only what the scripts and this suite call. Resolved from the host once,
# here, so nothing else on the host PATH is reachable during the checks.
mkdir -p "$work/tools"
for tool in sh git node awk sed grep basename dirname cat mktemp head rm sort cut tr wc cp mkdir chmod ln date od; do
  bin=$(command -v "$tool") || {
    echo "cannot find $tool on the host PATH" >&2
    exit 1
  }
  ln -s "$bin" "$work/tools/$tool"
done

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
    [ -n "${STUB_LIST_FAIL:-}" ] && {
      echo "connection refused" >&2
      exit 1
    }
    [ -n "${STUB_LIST_GARBAGE:-}" ] && {
      echo "unrecognized CLI output"
      exit 0
    }
    [ -n "${STUB_LIST_MALFORMED:-}" ] && {
      printf '\n  \n   Local          | Remote         | Time (UTC)          \n  ----------------|----------------|---------------------\n   this is not a row\n'
      exit 0
    }
    printf '\n  \n   Local          | Remote         | Time (UTC)          \n  ----------------|----------------|---------------------\n'
    : > "$STUB_TMP/local"
    for f in "$workdir"/supabase/migrations/*.sql; do
      [ -e "$f" ] || continue
      b=$(basename "$f")
      # like the CLI: a name without the 14-digit version is skipped
      case "$b" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.sql) ;;
        *) continue ;;
      esac
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
    echo "stub supabase: migration repair must not be called by the wrapper" >&2
    exit 98
    ;;
esac
echo "stub supabase: unexpected $*" >&2
exit 99
STUB
cat > "$work/stubs/psql" <<'STUB'
#!/bin/sh
# one log line per call: the file text passed as -v content= has newlines
printf 'psql %s\n' "$(printf '%s ' "$@" | tr '\n' ' ')" >> "$STUB_LOG"
version=''
query=''
prev=''
files=''
for a in "$@"; do
  case "$a" in version=*) version=${a#version=} ;; esac
  [ "$prev" = "-c" ] && query=$a
  [ "$prev" = "-f" ] && files="$files $a"
  prev=$a
done
case "$query" in
  *"CREATE DATABASE"*)
    [ -n "${STUB_CREATE_FAIL:-}" ] && {
      echo "ERROR: database already exists" >&2
      exit 1
    }
    exit 0
    ;;
  *"DROP DATABASE"*) exit 0 ;;
  *"SELECT current_database()"*)
    if [ -n "${STUB_CURRENT_DB:-}" ]; then echo "$STUB_CURRENT_DB"; else printf '%s\n' "$1" | sed -E 's#^.*/([^/?]*)(\?.*)?$#\1#'; fi
    exit 0
    ;;
  *"SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '"*)
    [ -n "${STUB_PRECHECK_RC:-}" ] && {
      echo "connection refused" >&2
      exit "$STUB_PRECHECK_RC"
    }
    v=${query##*version = \'}
    v=${v%\'*}
    grep -cx "$v" "$STUB_LEDGER"
    exit 0
    ;;
esac
: > "$STUB_TMP/handed.sql"
for f in $files; do
  [ -f "$f" ] || continue
  printf -- '-- file: %s\n' "$(basename "$f")" >> "$STUB_TMP/handed.sql"
  cat "$f" >> "$STUB_TMP/handed.sql"
done
rc=${STUB_PSQL_RC:-0}
[ "$rc" -eq 0 ] && [ -n "$version" ] && echo "$version" >> "$STUB_LEDGER"
exit "$rc"
STUB
chmod +x "$work/stubs/supabase" "$work/stubs/psql"

mkdir -p "$work/stubs-nopsql"
cp "$work/stubs/supabase" "$work/stubs-nopsql/supabase"

PATH="$work/stubs:$work/tools"
export PATH
STUB_LOG="$work/calls.log"
STUB_LEDGER="$work/ledger.txt"
STUB_TMP="$work"
# A synthetic password, so the redaction checks have something to look for.
STUB_DB_URL='postgresql://stub:s3cretpw@127.0.0.1:1/stub'
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
printf -- '-- a comment mentioning BEGIN; is fine\nBEGIN;\nselect 5;\nCOMMIT;\n' > "$mig/20260105000000_five.sql"
printf 'select 0;\n' > "$mig/001_bad.sql"
printf 'select 9;\n' > "$repo/20260109000000_stray.sql"

calls() { cat "$STUB_LOG"; }
reset_log() { : > "$STUB_LOG"; }
apply_calls() { calls | grep -c '^psql.* -f '; }

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

# --- refusals before any apply ---------------------------------------------

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/001_bad.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "$(apply_calls)" -eq 0 ] && echo "$out" | grep -q 'date -u'; then
  ok "a file without the 14-digit version is refused before any apply"
else
  bad "a file without the 14-digit version is refused before any apply" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$repo" && sh "$script" apply 20260109000000_stray.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "$(apply_calls)" -eq 0 ] && echo "$out" | grep -q 'supabase/migrations'; then
  ok "a file outside supabase/migrations is refused before any apply"
else
  bad "a file outside supabase/migrations is refused before any apply" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260199000000_missing.sql 2>&1)
rc=$?
[ "$rc" -eq 2 ] && [ "$(apply_calls)" -eq 0 ] && ok "a missing file is refused" || bad "a missing file is refused" "exit $rc: $out"

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260105000000_five.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'transaction control: BEGIN' && echo "$out" | grep -q 'single-transaction'; then
  ok "a file carrying its own BEGIN/COMMIT is refused before psql, naming the statement and why"
else
  bad "a file carrying its own BEGIN/COMMIT is refused before psql, naming the statement and why" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

# --- transaction control is judged SQL-aware ---------------------------------
# Its own fixture checkout, so the counts in the status checks stay put.
tc="$work/tc"
mkdir -p "$tc/supabase/migrations"
(cd "$tc" && git init -q -b main && git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg") || bad "tc fixture" "git init failed"
tcm="$tc/supabase/migrations"
: > "$work/ledger-tc.txt"
printf 'SELECT 1;\nCOMMIT WORK;\n' > "$tcm/20260201000000_commit_work.sql"
printf 'SELECT 1; COMMIT;\n' > "$tcm/20260202000000_two_on_a_line.sql"
printf 'SELECT 1;\nEND;\n' > "$tcm/20260203000000_end.sql"
printf 'SELECT 1;\nROLLBACK WORK;\n' > "$tcm/20260204000000_rollback_work.sql"
printf 'START TRANSACTION;\nSELECT 1;\n' > "$tcm/20260205000000_start.sql"
printf 'SAVEPOINT a;\nSELECT 1;\nRELEASE a;\n' > "$tcm/20260206000000_savepoint.sql"
printf 'SELECT 1;\n\\connect other\nSELECT 2;\n' > "$tcm/20260207000000_meta.sql"
printf 'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\n' > "$tcm/20260208000000_atomic.sql"
printf 'COMMIT AND CHAIN;\n' > "$tcm/20260209000000_chain.sql"
printf 'SELECT 1 \\gset\n' > "$tcm/20260210000000_gset.sql"
printf 'SELECT 1 AS foo$tag$; COMMIT; SELECT 1 AS foo$tag$;\n' > "$tcm/20260218000000_ident_dollar_bypass.sql"
printf 'SELECT 1 AS foo$$; COMMIT; SELECT 1 AS bar$$;\n' > "$tcm/20260219000000_ident_dollardollar_bypass.sql"
for f in 20260201000000_commit_work 20260202000000_two_on_a_line 20260203000000_end 20260204000000_rollback_work \
  20260205000000_start 20260206000000_savepoint 20260207000000_meta 20260208000000_atomic 20260209000000_chain 20260210000000_gset \
  20260218000000_ident_dollar_bypass 20260219000000_ident_dollardollar_bypass; do
  reset_log
  out=$(cd "$tc" && STUB_LEDGER="$work/ledger-tc.txt" sh "$script" apply "supabase/migrations/$f.sql" 2>&1)
  rc=$?
  if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql'; then
    ok "refused before psql: $f"
  else
    bad "refused before psql: $f" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
  fi
done
printf '/* COMMIT; */\nSELECT 1;\n' > "$tcm/20260211000000_block_comment.sql"
printf -- '-- COMMIT;\nSELECT 1; -- END;\n' > "$tcm/20260212000000_line_comment.sql"
printf "SELECT 'COMMIT;';\nSELECT \"END\" FROM (SELECT 1 AS \"END\") s;\n" > "$tcm/20260213000000_quoted.sql"
printf 'CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1;\n  COMMIT;\nEND;\n$$;\n' > "$tcm/20260214000000_dollar_body.sql"
printf 'CREATE OR REPLACE FUNCTION g() RETURNS int LANGUAGE plpgsql AS $fn$\nDECLARE x int;\nBEGIN\n  x := 1;\n  RETURN x;\nEND;\n$fn$;\nSELECT g();\n' > "$tcm/20260215000000_tagged_body.sql"
printf 'SELECT CASE WHEN true THEN 1 END;\n' > "$tcm/20260216000000_case_end.sql"
printf "DO \$\$ BEGIN RAISE NOTICE 'it''s fine'; END \$\$;\n" > "$tcm/20260217000000_do_block.sql"
printf 'SELECT 1 AS foo$tag$;\nSELECT 2 AS x$$;\n' > "$tcm/20260220000000_ident_with_dollar.sql"
printf 'SELECT $$COMMIT;$$;\nSELECT 1;\n' > "$tcm/20260221000000_dollar_string_at_boundary.sql"
for f in 20260211000000_block_comment 20260212000000_line_comment 20260213000000_quoted 20260214000000_dollar_body \
  20260215000000_tagged_body 20260216000000_case_end 20260217000000_do_block 20260220000000_ident_with_dollar 20260221000000_dollar_string_at_boundary; do
  reset_log
  out=$(cd "$tc" && STUB_LEDGER="$work/ledger-tc.txt" sh "$script" apply "supabase/migrations/$f.sql" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ]; then
    ok "accepted and applied: $f"
  else
    bad "accepted and applied: $f" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
  fi
done
out=$(awk -f "$guard" "$tcm/20260201000000_commit_work.sql" 2>&1)
rc=$?
[ "$rc" -eq 1 ] && [ "$out" = "transaction control: COMMIT WORK" ] && ok "the scanner names the offending statement and exits 1" ||
  bad "the scanner names the offending statement and exits 1" "exit $rc: $out"
out=$(awk -f "$guard" "$tcm/20260214000000_dollar_body.sql" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "the scanner is silent and exits 0 on a clean file" || bad "the scanner is silent and exits 0 on a clean file" "exit $rc: $out"

reset_log
out=$(cd "$repo" && STUB_NO_STACK=1 sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'supabase start' &&
  ! echo "$out" | grep -q 'start it with: yarn supabase:local:setup'; then
  ok "a stopped stack is refused before psql; the hint is supabase start, not the resetting setup script"
else
  bad "a stopped stack is refused before psql; the hint is supabase start, not the resetting setup script" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && PATH="$work/stubs-nopsql:$work/tools" sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'psql not found'; then
  ok "a missing psql is refused with an install hint (hermetic PATH)"
else
  bad "a missing psql is refused with an install hint (hermetic PATH)" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && STUB_PRECHECK_RC=1 sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "$(apply_calls)" -eq 0 ] && [ "$(calls | grep -c '^psql')" -eq 1 ] &&
  ! grep -qx 20260101000000 "$STUB_LEDGER" && echo "$out" | grep -q 'could not read the ledger'; then
  ok "a recorded-count read that fails is a refusal: one psql call, no apply, no row"
else
  bad "a recorded-count read that fails is a refusal: one psql call, no apply, no row" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
if ! echo "$out" | grep -q 's3cretpw' && ! echo "$out" | grep -q '127.0.0.1:1' && calls | grep -q 's3cretpw'; then
  ok "the failure never prints the endpoint, while psql received the real one"
else
  bad "the failure never prints the endpoint, while psql received the real one" "$out"
fi

reset_log
out=$(cd "$repo" && DB_MIGRATE_URL='postgresql://stub@127.0.0.1:1/stub?password=qsSECRET' STUB_PRECHECK_RC=1 sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'qsSECRET' && calls | grep -q 'qsSECRET' && ! calls | grep -q '^supabase status'; then
  ok "DB_MIGRATE_URL with a ?password= parameter: used by psql, never printed, and supabase status is not asked"
else
  bad "DB_MIGRATE_URL with a ?password= parameter: used by psql, never printed, and supabase status is not asked" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$repo" && DB_MIGRATE_URL='host=127.0.0.1 port=1 dbname=stub user=stub password=kvSECRET' STUB_PRECHECK_RC=1 sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'kvSECRET' && calls | grep -q 'kvSECRET' &&
  ok "DB_MIGRATE_URL in keyword/value form: used by psql, never printed" ||
  bad "DB_MIGRATE_URL in keyword/value form: used by psql, never printed" "exit $rc: $out"

# --- the happy path ---------------------------------------------------------

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
psql_line=$(calls | grep '^psql.* -f ')
if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ] && ! calls | grep -q '^supabase migration' &&
  echo "$out" | grep -q 'recorded 20260101000000_one.sql as 20260101000000'; then
  ok "one apply call does it all; the CLI's migration commands are never invoked"
else
  bad "one apply call does it all; the CLI's migration commands are never invoked" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
if echo "$psql_line" | grep -q -- ' -1 ' && echo "$psql_line" | grep -q 'ON_ERROR_STOP=1' &&
  echo "$psql_line" | grep -q -- '-f supabase/migrations/20260101000000_one.sql' && echo "$psql_line" | grep -q "$STUB_DB_URL"; then
  ok "psql runs in one transaction, stopping on error, against the stack's DB_URL, with the file as given"
else
  bad "psql runs in one transaction, stopping on error, against the stack's DB_URL, with the file as given" "$psql_line"
fi
if echo "$psql_line" | grep -q -- '-v version=20260101000000' && echo "$psql_line" | grep -q -- '-v name=one' &&
  echo "$psql_line" | grep -q -- '-v content=select 1;'; then
  ok "version, name and file text reach SQL as psql variables, not shell interpolation"
else
  bad "version, name and file text reach SQL as psql variables, not shell interpolation" "$psql_line"
fi
handed="$work/handed.sql"
if grep -q "pg_advisory_xact_lock(hashtext('db-migrate'), hashtext(:'version'))" "$handed" &&
  grep -q "INSERT INTO supabase_migrations.schema_migrations (version, name, statements)" "$handed" &&
  grep -q "VALUES (:'version', :'name', ARRAY\[:'content'\])" "$handed"; then
  ok "the SQL handed to psql takes the advisory lock and inserts the ledger row"
else
  bad "the SQL handed to psql takes the advisory lock and inserts the ledger row" "$(cat "$handed" | tr '\n' ' ')"
fi
lock_ln=$(grep -n 'pg_advisory_xact_lock' "$handed" | cut -d: -f1 | head -1)
row_ln=$(grep -n 'INSERT INTO supabase_migrations' "$handed" | cut -d: -f1 | head -1)
file_ln=$(grep -n -- '-- file: 20260101000000_one.sql' "$handed" | cut -d: -f1 | head -1)
if [ -n "$lock_ln" ] && [ -n "$row_ln" ] && [ -n "$file_ln" ] && [ "$lock_ln" -lt "$row_ln" ] && [ "$row_ln" -lt "$file_ln" ]; then
  ok "order inside the transaction: lock, then ledger row, then the file"
else
  bad "order inside the transaction: lock, then ledger row, then the file" "lock=$lock_ln row=$row_ln file=$file_ln"
fi
grep -qx 20260101000000 "$STUB_LEDGER" && ok "the row lands under the file's own version" || bad "the row lands under the file's own version" "$(cat "$STUB_LEDGER" | tr '\n' ' ')"

reset_log
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 0 ] && echo "$out" | grep -q 'already recorded'; then
  ok "an already-recorded version is skipped without an apply"
else
  bad "an already-recorded version is skipped without an apply" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

# --- failures ---------------------------------------------------------------

reset_log
out=$(cd "$repo" && STUB_PSQL_RC=1 sh "$script" apply supabase/migrations/20260102000000_two.sql 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && ! grep -qx 20260102000000 "$STUB_LEDGER" && echo "$out" | grep -q 'rolled back' &&
  echo "$out" | grep -q 'schema_migrations_pkey'; then
  ok "a failed transaction writes no ledger row, and names the duplicate-key case a concurrent run produces"
else
  bad "a failed transaction writes no ledger row, and names the duplicate-key case a concurrent run produces" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$repo" && STUB_PSQL_RC=1 sh "$script" apply supabase/migrations/20260102000000_two.sql supabase/migrations/20260103000000_three.sql 2>&1)
rc=$?
n=$(apply_calls)
[ "$rc" -eq 1 ] && [ "$n" -eq 2 ] && ok "several files: every file is attempted and any failure fails the run" ||
  bad "several files: every file is attempted and any failure fails the run" "exit $rc, apply calls $n: $out"

# --- from a worktree with a divergent config -------------------------------

(cd "$repo" && git worktree add -q "$work/wt" -b feature) || bad "fixture worktree" "git worktree add failed"
mkdir -p "$work/wt/supabase/migrations"
cp "$mig/20260104000000_four.sql" "$work/wt/supabase/migrations/"
printf '[db]\nport = 55422\n' > "$work/wt/supabase/config.toml"
reset_log
out=$(cd "$work/wt" && sh "$script" apply supabase/migrations/20260104000000_four.sql 2>&1)
rc=$?
status_line=$(calls | grep '^supabase status')
psql_off_root=$(calls | grep '^psql' | grep -vc "$STUB_DB_URL")
if [ "$rc" -eq 0 ] && echo "$status_line" | grep -q -- "--workdir $repo" && [ "$psql_off_root" -eq 0 ] &&
  ! calls | grep -q '55422' && grep -qx 20260104000000 "$STUB_LEDGER"; then
  ok "from a worktree: the stack is asked through the root and every psql call uses that DB_URL; the worktree's config.toml is never consulted"
else
  bad "from a worktree: the stack is asked through the root and every psql call uses that DB_URL; the worktree's config.toml is never consulted" "exit $rc: $out; status: $status_line; off-root psql: $psql_off_root; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$work/wt" && sh "$script" status 2>&1)
rc=$?
list_line=$(calls | grep '^supabase migration list')
if [ "$rc" -eq 0 ] && echo "$list_line" | grep -q -- "--db-url $STUB_DB_URL" && echo "$list_line" | grep -q -- "--workdir $work/wt"; then
  ok "status from a worktree lists that worktree's files against the root stack's DB_URL"
else
  bad "status from a worktree lists that worktree's files against the root stack's DB_URL" "exit $rc: $out; list: $list_line"
fi

# --- status -----------------------------------------------------------------

echo 20260999000000 >> "$STUB_LEDGER"
out=$(cd "$repo" && sh "$script" status 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q '2 recorded, 3 pending in this checkout, 1 applied from another checkout' &&
  echo "$out" | grep -q 'yarn db:migrate supabase/migrations/<file>'; then
  ok "status counts recorded, pending, and rows applied from another checkout"
else
  bad "status counts recorded, pending, and rows applied from another checkout" "exit $rc: $out"
fi

reset_log
out=$(cd "$repo" && STUB_LIST_FAIL=1 sh "$script" status 2>&1)
rc=$?
[ "$rc" -eq 2 ] && echo "$out" | grep -q 'migration list failed' && ! echo "$out" | grep -q 's3cretpw' && ! echo "$out" | grep -q '127.0.0.1:1' &&
  ok "status refuses when the listing fails, without printing the endpoint" || bad "status refuses when the listing fails, without printing the endpoint" "exit $rc: $out"

# --- migration-status.mjs reads the same table ------------------------------

out=$(node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 10 ] && echo "$out" | grep -q '3 pending local migrations' && echo "$out" | grep -q '20260102000000' &&
  echo "$out" | grep -q 'yarn db:migrate'; then
  ok "migration-status.mjs: local-only rows are pending, exit 10, with the local apply hint"
else
  bad "migration-status.mjs: local-only rows are pending, exit 10, with the local apply hint" "exit $rc: $out"
fi

out=$(node "$status_mjs" --local --workdir "$repo" --json 2>&1)
rc=$?
if [ "$rc" -eq 10 ] && echo "$out" | grep -q '"pendingCount":3' && echo "$out" | grep -q '"elsewhereCount":1'; then
  ok "migration-status.mjs --json carries pendingCount and elsewhereCount"
else
  bad "migration-status.mjs --json carries pendingCount and elsewhereCount" "exit $rc: $out"
fi

out=$(node "$status_mjs" --local --workdir "$repo" --warn-only 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok "migration-status.mjs --warn-only exits 0 with pending rows" || bad "migration-status.mjs --warn-only exits 0 with pending rows" "exit $rc: $out"

out=$(node "$status_mjs" --linked --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 10 ] && echo "$out" | grep -q 'yarn linked:migrate' && ! echo "$out" | grep -q 'db:migrate'; then
  ok "migration-status.mjs: a linked target gets the linked apply hint, never the local-only command"
else
  bad "migration-status.mjs: a linked target gets the linked apply hint, never the local-only command" "exit $rc: $out"
fi

echo 20260102000000 >> "$STUB_LEDGER"
echo 20260103000000 >> "$STUB_LEDGER"
echo 20260105000000 >> "$STUB_LEDGER"
out=$(node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q 'No pending local migrations' && echo "$out" | grep -q '1 applied from another checkout'; then
  ok "migration-status.mjs: a remote-only row is reported but is not pending"
else
  bad "migration-status.mjs: a remote-only row is reported but is not pending" "exit $rc: $out"
fi

empty="$work/empty"
mkdir -p "$empty/supabase/migrations"
: > "$STUB_LEDGER"
out=$(node "$status_mjs" --local --workdir "$empty" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && echo "$out" | grep -q 'No pending local migrations' && ok "migration-status.mjs: a valid empty table is clean" ||
  bad "migration-status.mjs: a valid empty table is clean" "exit $rc: $out"

out=$(STUB_LIST_GARBAGE=1 node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q 'Unable to determine' && ! echo "$out" | grep -q 'No pending'; then
  ok "migration-status.mjs: output without the table header is unknown, exit 2, never clean"
else
  bad "migration-status.mjs: output without the table header is unknown, exit 2, never clean" "exit $rc: $out"
fi

out=$(STUB_LIST_GARBAGE=1 node "$status_mjs" --local --workdir "$repo" --warn-only 2>&1)
rc=$?
[ "$rc" -eq 0 ] && echo "$out" | grep -q 'Unable to determine' && ok "migration-status.mjs: unknown output under --warn-only still warns, exits 0" ||
  bad "migration-status.mjs: unknown output under --warn-only still warns, exits 0" "exit $rc: $out"

out=$(STUB_LIST_MALFORMED=1 node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q 'malformed row' && ! echo "$out" | grep -q 'No pending'; then
  ok "migration-status.mjs: a good header followed by a malformed row is unknown, never clean"
else
  bad "migration-status.mjs: a good header followed by a malformed row is unknown, never clean" "exit $rc: $out"
fi

out=$(STUB_LIST_FAIL=1 node "$status_mjs" --local --workdir "$repo" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q 'Unable to determine'; then
  ok "migration-status.mjs: a failing CLI is reported as unknown, exit 2"
else
  bad "migration-status.mjs: a failing CLI is reported as unknown, exit 2" "exit $rc: $out"
fi

# --- the integration harness's own refusals (stubs; no database) ------------

reset_log
out=$(STUB_CREATE_FAIL=1 DB_MIGRATE_TEST_ADMIN_URL='postgresql://stub:pw@127.0.0.1:1/postgres' sh "$itest" 2>&1)
rc=$?
if [ "$rc" -ne 0 ] && ! calls | grep -q 'DROP DATABASE' && calls | grep -q 'CREATE DATABASE'; then
  ok "integration harness: a failed CREATE DATABASE issues no DROP"
else
  bad "integration harness: a failed CREATE DATABASE issues no DROP" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(STUB_CURRENT_DB=fixture_existing DB_MIGRATE_TEST_ADMIN_URL='postgresql://stub:pw@127.0.0.1:1/postgres' sh "$itest" 2>&1)
rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -q 'fixture_existing' && ! calls | grep -q 'CREATE SCHEMA' && calls | grep -q 'DROP DATABASE'; then
  ok "integration harness: a connection reporting another database stops before DDL, and drops only what it created"
else
  bad "integration harness: a connection reporting another database stops before DDL, and drops only what it created" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

out=$(DB_MIGRATE_TEST_ADMIN_URL='postgresql://stub:pw@127.0.0.1:1/postgres?dbname=elsewhere' sh "$itest" 2>&1)
rc=$?
[ "$rc" -eq 2 ] && echo "$out" | grep -q 'dbname=' && ok "integration harness: a dbname= override on the admin URL is refused" ||
  bad "integration harness: a dbname= override on the admin URL is refused" "exit $rc: $out"

out=$(DB_MIGRATE_TEST_ADMIN_URL='host=127.0.0.1 port=1 user=stub password=pw' sh "$itest" 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "integration harness: a keyword/value admin string is refused (only a URL is parsed)" ||
  bad "integration harness: a keyword/value admin string is refused (only a URL is parsed)" "exit $rc: $out"

out=$(DB_MIGRATE_TEST_ADMIN_URL='postgresql://stub:pw@127.0.0.1:54322/postgres' sh "$itest" 2>&1)
rc=$?
[ "$rc" -eq 2 ] && echo "$out" | grep -q 'shared local stack' && ok "integration harness: the shared stack's port is refused" ||
  bad "integration harness: the shared stack's port is refused" "exit $rc: $out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
