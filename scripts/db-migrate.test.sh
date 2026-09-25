#!/bin/sh
# Regression coverage for scripts/db-migrate.sh (apply a migration file to the
# local stack and record it in the ledger under the file's own version; apply
# the pending set), for the table parsing in scripts/migration-status.mjs, and
# for scripts/preflight.mjs (what `yarn dev` runs before the servers start).
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
#   - `pending` applies the ledger's gaps in version order, one transaction
#     each, stops in front of a window migration (exit 3) naming its runbook,
#     and refuses an ambiguous version; `apply` takes a window file only with
#     --window; a marker below line ten is not a marker
#   - the startup preflight applies pending files from the main checkout and
#     stops the start when one fails or a window migration is pending; a
#     worktree warns and applies nothing; a linked target refuses and points
#     at linked:migrate; INK_SKIP_MIGRATIONS=1 starts anyway and says so
#   - (review round 1) the listing is judged whole before any row is acted on,
#     by the wrapper and by migration-status.mjs alike; `pending --for` proves
#     the root stack is the one the runtime names, port and all; the preflight
#     pins its children to its own checkout whatever the caller's cwd; and
#     prod:migrate sits behind the same window guard on both targets, the
#     local one going through the wrapper
#   - (review round 2) under --for the connection is bound to the proof: one
#     status answer gives both the API URL checked and the DB URL used, and
#     DB_MIGRATE_URL is refused; the runtime URL comes from the runtime's own
#     env loader (scripts/lib/runtime-env.mjs: process env, .env.local,
#     .env.{NODE_ENV} with aliases, .env; LOCAL_SUPABASE_URL means nothing);
#     prod:migrate reads one validated listing and never a second; every
#     diagnostic names an origin, never userinfo, query or fragment; a file
#     that cannot be read is a refusal, never a non-window
#   - (review round 3) the origin comes from the URL parser, so a password
#     containing "@" is still userinfo and an unparseable value is a refusal
#     that shows nothing; prod:direct and prod:migrate decide NODE_ENV
#     (production unless the caller says otherwise) before any migration
#     decision, so the proof reads the layer the server will
#
# Usage:  sh scripts/db-migrate.test.sh
#
# SCRIPT_UNDER_TEST, STATUS_UNDER_TEST, PREFLIGHT_UNDER_TEST,
# PROD_MIGRATE_UNDER_TEST and PROD_DIRECT_UNDER_TEST point the suite at other
# copies of the five scripts, so a check can be shown red against an older
# head.

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
for tool in sh bash git node awk sed grep basename dirname cat mktemp head rm mv sort cut tr wc cp mkdir chmod ln date od locale env; do
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
    # STUB_LIST_FAULT_FROM_CALL=N faults this and every later listing call
    # (the log line above already counts this one); the kind is
    # STUB_LIST_FAULT_KIND, fail (exit 1) or garbage (exit 0, no table).
    if [ -n "${STUB_LIST_FAULT_FROM_CALL:-}" ] && [ "$(grep -c '^supabase migration list' "$STUB_LOG")" -ge "$STUB_LIST_FAULT_FROM_CALL" ]; then
      if [ "${STUB_LIST_FAULT_KIND:-fail}" = "garbage" ]; then
        echo "unrecognized CLI output"
        exit 0
      fi
      echo "connection refused" >&2
      exit 1
    fi
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
    [ -n "${STUB_LIST_PREPEND_MALFORMED:-}" ] && printf '   this is not a row\n'
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
  "db push")
    # stands in for the CLI: every local file the ledger lacks is recorded
    for f in "$workdir"/supabase/migrations/*.sql; do
      [ -e "$f" ] || continue
      b=$(basename "$f")
      case "$b" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.sql) ;;
        *) continue ;;
      esac
      v=${b%%_*}
      grep -qx "$v" "$STUB_LEDGER" || echo "$v" >> "$STUB_LEDGER"
    done
    exit 0
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
# caf\303\251 is "café": a non-ASCII identifier character before the $
printf 'SELECT 1 AS caf\303\251$tag$; COMMIT; SELECT 1 AS caf\303\251$tag$;\n' > "$tcm/20260222000000_ident_nonascii_bypass.sql"
# no semicolon, no newline, the file ends inside a line comment
printf 'CREATE TABLE t (id int);\nROLLBACK -- final comment' > "$tcm/20260224000000_eof_in_line_comment.sql"
# \015 is a bare CR: PostgreSQL ends a line comment there too
printf -- '-- comment\015COMMIT;\nSELECT 1;\n' > "$tcm/20260225000000_cr_ends_comment.sql"
printf 'SELECT 1;\015\nCOMMIT;\015\n' > "$tcm/20260226000000_crlf_commit.sql"
printf 'ROLLBACK' > "$tcm/20260227000000_eof_no_semicolon.sql"
for f in 20260201000000_commit_work 20260202000000_two_on_a_line 20260203000000_end 20260204000000_rollback_work \
  20260205000000_start 20260206000000_savepoint 20260207000000_meta 20260208000000_atomic 20260209000000_chain 20260210000000_gset \
  20260218000000_ident_dollar_bypass 20260219000000_ident_dollardollar_bypass 20260222000000_ident_nonascii_bypass \
  20260224000000_eof_in_line_comment 20260225000000_cr_ends_comment 20260226000000_crlf_commit 20260227000000_eof_no_semicolon; do
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
printf 'SELECT 1 AS caf\303\251$tag$;\nSELECT $caf\303\251$ BEGIN; COMMIT; $caf\303\251$;\n' > "$tcm/20260223000000_nonascii_ident_and_tag.sql"
printf 'SELECT 1 -- trailing comment, no newline' > "$tcm/20260228000000_eof_benign_comment.sql"
printf -- '-- comment\015SELECT 1;\n' > "$tcm/20260229000000_cr_benign.sql"
printf 'SELECT 1;\015\nSELECT 2; -- COMMIT;\015\n' > "$tcm/20260230000000_crlf_benign.sql"
printf 'SELECT 1 -- COMMIT;' > "$tcm/20260231000000_eof_comment_mentions_commit.sql"
for f in 20260211000000_block_comment 20260212000000_line_comment 20260213000000_quoted 20260214000000_dollar_body \
  20260215000000_tagged_body 20260216000000_case_end 20260217000000_do_block 20260220000000_ident_with_dollar 20260221000000_dollar_string_at_boundary 20260223000000_nonascii_ident_and_tag \
  20260228000000_eof_benign_comment 20260229000000_cr_benign 20260230000000_crlf_benign 20260231000000_eof_comment_mentions_commit; do
  reset_log
  out=$(cd "$tc" && STUB_LEDGER="$work/ledger-tc.txt" sh "$script" apply "supabase/migrations/$f.sql" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ]; then
    ok "accepted and applied: $f"
  else
    bad "accepted and applied: $f" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
  fi
done
out=$(LC_ALL=C awk -f "$guard" "$tcm/20260201000000_commit_work.sql" 2>&1)
rc=$?
[ "$rc" -eq 1 ] && [ "$out" = "transaction control: COMMIT WORK" ] && ok "the scanner names the offending statement and exits 1" ||
  bad "the scanner names the offending statement and exits 1" "exit $rc: $out"
out=$(LC_ALL=C awk -f "$guard" "$tcm/20260214000000_dollar_body.sql" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "the scanner is silent and exits 0 on a clean file" || bad "the scanner is silent and exits 0 on a clean file" "exit $rc: $out"

# The wrapper's verdict must not depend on the caller's locale: the same
# non-ASCII bypass and the same benign file, under C and under a UTF-8 locale.
utf8=$(locale -a 2>/dev/null | grep -iE '^(C|en_US)\.(UTF-8|utf8)$' | head -1)
[ -n "$utf8" ] || bad "a UTF-8 locale is available for the locale-independence checks" "locale -a listed none"
for loc in C ${utf8:-}; do
  reset_log
  out=$(cd "$tc" && LC_ALL="$loc" STUB_LEDGER="$work/ledger-tc.txt" sh "$script" apply supabase/migrations/20260222000000_ident_nonascii_bypass.sql 2>&1)
  rc=$?
  [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'transaction control: COMMIT' &&
    ok "under LC_ALL=$loc: the non-ASCII identifier bypass is refused before psql" ||
    bad "under LC_ALL=$loc: the non-ASCII identifier bypass is refused before psql" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
  reset_log
  : > "$work/ledger-tc-$loc.txt"
  out=$(cd "$tc" && LC_ALL="$loc" STUB_LEDGER="$work/ledger-tc-$loc.txt" sh "$script" apply supabase/migrations/20260223000000_nonascii_ident_and_tag.sql 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ] &&
    ok "under LC_ALL=$loc: a non-ASCII identifier and a non-ASCII dollar tag are accepted" ||
    bad "under LC_ALL=$loc: a non-ASCII identifier and a non-ASCII dollar tag are accepted" "exit $rc: $out"
done

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

# --- pending: the ledger's gaps, in version order, stopping at a window ------
# Its own fixture checkout and ledger, so the counts above stay put.

pend="$work/pend"
mkdir -p "$pend/supabase/migrations"
(cd "$pend" && git init -q -b main && git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg") || bad "pend fixture" "git init failed"
pm="$pend/supabase/migrations"
printf 'select 1;\n' > "$pm/20260301000000_a.sql"
printf 'select 2;\n' > "$pm/20260302000000_b.sql"
printf -- '-- the cutover\n-- db-migrate: window docs/runbooks/example-window.md\nselect 3;\n' > "$pm/20260303000000_c_window.sql"
printf 'select 4;\n' > "$pm/20260304000000_d.sql"
pl="$work/ledger-pend.txt"
printf '20260301000000\n' > "$pl"

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --dry-run 2>&1)
rc=$?
if [ "$rc" -eq 3 ] && [ "$(apply_calls)" -eq 0 ] && echo "$out" | grep -q 'would apply 20260302000000_b.sql' &&
  echo "$out" | grep -q 'stopped at 20260303000000_c_window.sql' && echo "$out" | grep -q 'docs/runbooks/example-window.md' &&
  ! echo "$out" | grep -q '20260304000000_d.sql' && [ "$(wc -l < "$pl" | tr -d ' ')" -eq 1 ]; then
  ok "pending --dry-run: names what it would apply, stops at the window file naming its runbook, touches nothing"
else
  bad "pending --dry-run: names what it would apply, stops at the window file naming its runbook, touches nothing" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
if [ "$rc" -eq 3 ] && [ "$(apply_calls)" -eq 1 ] && grep -qx 20260302000000 "$pl" && ! grep -qx 20260303000000 "$pl" &&
  ! grep -qx 20260304000000 "$pl" && echo "$out" | grep -q 'recorded 20260302000000_b.sql' &&
  echo "$out" | grep -q 'stopped at 20260303000000_c_window.sql' && echo "$out" | grep -q '1 later file'; then
  ok "pending: applies the gap before the window file, stops in front of it (exit 3), leaves the file behind it alone"
else
  bad "pending: applies the gap before the window file, stops in front of it (exit 3), leaves the file behind it alone" "exit $rc: $out; ledger: $(cat "$pl" | tr '\n' ' ')"
fi

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" apply supabase/migrations/20260303000000_c_window.sql 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'window migration' &&
  echo "$out" | grep -q 'docs/runbooks/example-window.md' && echo "$out" | grep -q -- '--window'; then
  ok "apply without --window refuses a window file before psql, naming the runbook and the flag"
else
  bad "apply without --window refuses a window file before psql, naming the runbook and the flag" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" apply --window supabase/migrations/20260303000000_c_window.sql 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ] && grep -qx 20260303000000 "$pl" && echo "$out" | grep -q 'window migration'; then
  ok "apply --window applies a window file and says so"
else
  bad "apply --window applies a window file and says so" "exit $rc: $out"
fi

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ] && grep -qx 20260304000000 "$pl" && echo "$out" | grep -q 'recorded 20260304000000_d.sql'; then
  ok "pending after the window: the file behind it is applied"
else
  bad "pending after the window: the file behind it is applied" "exit $rc: $out"
fi

reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'nothing pending' &&
  ok "pending with nothing pending: exit 0, no psql" || bad "pending with nothing pending: exit 0, no psql" "exit $rc: $out"

# A marker below line ten is prose, not a marker.
printf 'select 1;\nselect 2;\nselect 3;\nselect 4;\nselect 5;\nselect 6;\nselect 7;\nselect 8;\nselect 9;\nselect 10;\n-- db-migrate: window late\nselect 11;\n' > "$pm/20260305000000_e_late_marker.sql"
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
[ "$rc" -eq 0 ] && grep -qx 20260305000000 "$pl" && ok "a marker after line ten does not make a window file" ||
  bad "a marker after line ten does not make a window file" "exit $rc: $out"

printf 'select 6;\n' > "$pm/20260306000000_f.sql"
reset_log
out=$(cd "$pend" && STUB_PSQL_RC=1 STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
[ "$rc" -eq 1 ] && ! grep -qx 20260306000000 "$pl" && echo "$out" | grep -q 'rolled back' &&
  ok "pending: a file that fails exits 1 and records nothing" || bad "pending: a file that fails exits 1 and records nothing" "exit $rc: $out"

printf 'select 7;\n' > "$pm/20260307000000_g.sql"
printf 'select 7;\n' > "$pm/20260307000000_g_twin.sql"
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && grep -qx 20260306000000 "$pl" && ! grep -qx 20260307000000 "$pl" && echo "$out" | grep -q 'exactly one file for pending version 20260307000000'; then
  ok "pending: applies what precedes an ambiguous version, then refuses it before psql"
else
  bad "pending: applies what precedes an ambiguous version, then refuses it before psql" "exit $rc: $out; ledger: $(cat "$pl" | tr '\n' ' ')"
fi

# --- preflight: the restart is the deploy -----------------------------------
# preflight.mjs finds its scripts beside itself, so the fixture gets a copy
# of the four files; the stubs, tools and ledger are the ones above. The host
# shell may export the target's own variables, so each run unsets them: the
# fixture's .env.local decides the target.

preflight_src="${PREFLIGHT_UNDER_TEST:-$root/scripts/preflight.mjs}"
pf="$work/pf"
mkdir -p "$pf/scripts/lib" "$pf/supabase/migrations"
cp "$preflight_src" "$pf/scripts/preflight.mjs"
cp "$status_mjs" "$pf/scripts/migration-status.mjs"
cp "$script" "$pf/scripts/db-migrate.sh"
cp "$guard" "$pf/scripts/lib/sql-transaction-control.awk"
cp "$root/scripts/lib/runtime-env.mjs" "$pf/scripts/lib/runtime-env.mjs"
# the copied scripts import dotenv through the shared env loader
ln -s "$root/node_modules" "$pf/node_modules"
(cd "$pf" && git init -q -b main && git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg") || bad "pf fixture" "git init failed"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"
printf 'select 1;\n' > "$pf/supabase/migrations/20260401000000_p.sql"
pfl="$work/ledger-pf.txt"
: > "$pfl"
pf_run() {
  # $1 = checkout to run in; the rest = VAR=value assignments for this run
  dir=$1
  shift
  (
    cd "$dir" || exit 97
    unset SUPABASE_URL LOCAL_SUPABASE_URL INK_MIGRATION_TARGET INK_SKIP_MIGRATIONS DB_MIGRATE_URL NODE_ENV
    for kv in "$@"; do export "$kv"; done
    STUB_LEDGER="$pfl" node scripts/preflight.mjs 2>&1
  )
}

reset_log
out=$(pf_run "$pf")
rc=$?
if [ "$rc" -eq 0 ] && [ "$(apply_calls)" -eq 1 ] && grep -qx 20260401000000 "$pfl" && echo "$out" | grep -q 'Ready'; then
  ok "preflight, main checkout, local target: a pending file is applied before the start"
else
  bad "preflight, main checkout, local target: a pending file is applied before the start" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

printf 'select 2;\n' > "$pf/supabase/migrations/20260402000000_q.sql"
reset_log
out=$(pf_run "$pf" STUB_PSQL_RC=1)
rc=$?
if [ "$rc" -eq 1 ] && ! grep -qx 20260402000000 "$pfl" && echo "$out" | grep -q 'could not be applied' && echo "$out" | grep -q 'dev:no-migrations'; then
  ok "preflight: a file that fails to apply stops the start and names the escape hatch"
else
  bad "preflight: a file that fails to apply stops the start and names the escape hatch" "exit $rc: $out"
fi
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 0 ] && grep -qx 20260402000000 "$pfl" && ok "preflight: the next start applies it" || bad "preflight: the next start applies it" "exit $rc: $out"

printf -- '-- db-migrate: window docs/runbooks/example-window.md\nselect 3;\n' > "$pf/supabase/migrations/20260403000000_w.sql"
printf 'select 4;\n' > "$pf/supabase/migrations/20260404000000_after.sql"
reset_log
out=$(pf_run "$pf")
rc=$?
if [ "$rc" -eq 1 ] && ! calls | grep -q '^psql.* -f ' && ! grep -qx 20260403000000 "$pfl" && ! grep -qx 20260404000000 "$pfl" &&
  echo "$out" | grep -q 'docs/runbooks/example-window.md' && echo "$out" | grep -q 'window migration is pending' && echo "$out" | grep -q 'dev:no-migrations'; then
  ok "preflight: a pending window migration refuses the start, names the runbook, applies nothing"
else
  bad "preflight: a pending window migration refuses the start, names the runbook, applies nothing" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

reset_log
out=$(pf_run "$pf" INK_SKIP_MIGRATIONS=1)
rc=$?
if [ "$rc" -eq 0 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'SKIPPED' && echo "$out" | grep -q '2 pending' && echo "$out" | grep -q 'Ready'; then
  ok "preflight: INK_SKIP_MIGRATIONS=1 starts anyway, applies nothing, and lists what stays pending"
else
  bad "preflight: INK_SKIP_MIGRATIONS=1 starts anyway, applies nothing, and lists what stays pending" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

(cd "$pf" && git worktree add -q "$work/pfwt" -b pf-feature) || bad "pf worktree" "git worktree add failed"
mkdir -p "$work/pfwt/scripts/lib" "$work/pfwt/supabase/migrations"
cp "$pf/scripts/preflight.mjs" "$pf/scripts/migration-status.mjs" "$pf/scripts/db-migrate.sh" "$work/pfwt/scripts/"
cp "$guard" "$work/pfwt/scripts/lib/sql-transaction-control.awk"
cp "$root/scripts/lib/runtime-env.mjs" "$work/pfwt/scripts/lib/runtime-env.mjs"
ln -s "$root/node_modules" "$work/pfwt/node_modules"
cp "$pf/.env.local" "$work/pfwt/.env.local"
printf 'select 5;\n' > "$work/pfwt/supabase/migrations/20260405000000_branch.sql"
reset_log
out=$(pf_run "$work/pfwt")
rc=$?
if [ "$rc" -eq 0 ] && ! calls | grep -q '^psql' && ! grep -qx 20260405000000 "$pfl" && echo "$out" | grep -q 'worktree checkout' && echo "$out" | grep -q 'Ready'; then
  ok "preflight from a worktree: warns, applies nothing to the shared stack, starts"
else
  bad "preflight from a worktree: warns, applies nothing to the shared stack, starts" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi

printf 'SUPABASE_URL=https://example.supabase.co\n' > "$pf/.env.local"
reset_log
out=$(pf_run "$pf")
rc=$?
if [ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'linked:migrate' && ! echo "$out" | grep -q 'Ready'; then
  ok "preflight, linked target: pending refuses the start and points at yarn linked:migrate, never the local wrapper"
else
  bad "preflight, linked target: pending refuses the start and points at yarn linked:migrate, never the local wrapper" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"

reset_log
out=$(PATH="$work/tools" pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && echo "$out" | grep -q 'Supabase CLI not found' && ! echo "$out" | grep -q 'Ready' &&
  ok "preflight without the Supabase CLI: refuses to start" || bad "preflight without the Supabase CLI: refuses to start" "exit $rc: $out"
out=$(PATH="$work/tools" pf_run "$pf" INK_SKIP_MIGRATIONS=1)
rc=$?
[ "$rc" -eq 0 ] && echo "$out" | grep -q 'Ready' &&
  ok "preflight without the Supabase CLI, skipped by request: starts" || bad "preflight without the Supabase CLI, skipped by request: starts" "exit $rc: $out"

# --- review round 1 (Lumen, PR #675): the listing is judged whole ----------

for knob in STUB_LIST_GARBAGE STUB_LIST_MALFORMED STUB_LIST_PREPEND_MALFORMED; do
  reset_log
  printf '20260301000000\n20260302000000\n' > "$pl"
  out=$(cd "$pend" && export "$knob=1" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
  rc=$?
  if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'unrecognized' && [ "$(wc -l < "$pl" | tr -d ' ')" -eq 2 ]; then
    ok "pending under $knob: the listing is refused whole, nothing applied"
  else
    bad "pending under $knob: the listing is refused whole, nothing applied" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
  fi
done
# A malformed line ahead of a valid pending row must not let the row through.
reset_log
printf '20260301000000\n20260302000000\n20260303000000\n' > "$pl"
out=$(cd "$pend" && STUB_LIST_PREPEND_MALFORMED=1 STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ! grep -qx 20260304000000 "$pl" && ! calls | grep -q '^psql' &&
  ok "pending: a malformed row before a valid pending row applies nothing" ||
  bad "pending: a malformed row before a valid pending row applies nothing" "exit $rc: $out; ledger: $(cat "$pl" | tr '\n' ' ')"
reset_log
out=$(cd "$pend" && STUB_LIST_MALFORMED=1 STUB_LEDGER="$pl" sh "$script" status 2>&1)
rc=$?
[ "$rc" -eq 2 ] && echo "$out" | grep -q 'malformed row' && ! echo "$out" | grep -q 'recorded,' &&
  ok "status: a malformed row is a refusal, never a count" || bad "status: a malformed row is a refusal, never a count" "exit $rc: $out"
# The wrapper and migration-status.mjs agree on what a listing is.
for knob in STUB_LIST_GARBAGE STUB_LIST_MALFORMED STUB_LIST_PREPEND_MALFORMED; do
  m=$(cd "$pend" && export "$knob=1" && STUB_LEDGER="$pl" node "$status_mjs" --local --workdir "$pend" --json 2>/dev/null; echo "rc=$?")
  w=$(cd "$pend" && export "$knob=1" && STUB_LEDGER="$pl" sh "$script" pending --dry-run >/dev/null 2>&1; echo "rc=$?")
  echo "$m" | grep -q '"state":"unknown"' && [ "$w" = "rc=2" ] &&
    ok "under $knob: migration-status.mjs says unknown and the wrapper refuses" ||
    bad "under $knob: migration-status.mjs says unknown and the wrapper refuses" "mjs: $m; wrapper: $w"
done

# --- review round 1: the stack must be the one the runtime names ---------

reset_log
printf '20260301000000\n20260302000000\n20260303000000\n20260304000000\n20260305000000\n' > "$pl"
printf 'select 8;\n' > "$pm/20260308000000_h.sql"
rm -f "$pm/20260307000000_g_twin.sql"
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for http://127.0.0.1:55421 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && ! calls | grep -q '^supabase migration list' &&
  echo "$out" | grep -q '55421' && echo "$out" | grep -q '54321' && echo "$out" | grep -q 'Nothing applied'; then
  ok "pending --for a URL on another port: refused before the listing is even read, both API URLs named"
else
  bad "pending --for a URL on another port: refused before the listing is even read, both API URLs named" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
if ! echo "$out" | grep -q 's3cretpw'; then
  ok "the mismatch message names API URLs only, never the connection string"
else
  bad "the mismatch message names API URLs only, never the connection string" "$out"
fi
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for http://LOCALHOST:54321/ 2>&1)
rc=$?
[ "$rc" -eq 0 ] && grep -qx 20260306000000 "$pl" && ok "pending --for the stack's own URL (localhost spelling, trailing slash) applies" ||
  bad "pending --for the stack's own URL (localhost spelling, trailing slash) applies" "exit $rc: $out"
reset_log
out=$(cd "$pend" && STUB_NO_STACK=1 STUB_LEDGER="$pl" sh "$script" pending --for http://127.0.0.1:54321 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && ok "pending --for with the stack down: refused before psql" ||
  bad "pending --for with the stack down: refused before psql" "exit $rc: $out"

out=$(cd "$pend" && sh "$script" is-window supabase/migrations/20260303000000_c_window.sql 2>&1)
rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "docs/runbooks/example-window.md" ] && ok "is-window: a marked file exits 0 and prints its runbook" ||
  bad "is-window: a marked file exits 0 and prints its runbook" "exit $rc: $out"
out=$(cd "$pend" && sh "$script" is-window supabase/migrations/20260301000000_a.sql 2>&1)
rc=$?
[ "$rc" -eq 1 ] && [ -z "$out" ] && ok "is-window: an ordinary file exits 1, silently" || bad "is-window: an ordinary file exits 1, silently" "exit $rc: $out"
out=$(cd "$pend" && PATH="$work/tools" sh "$script" is-window supabase/migrations/20260303000000_c_window.sql 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok "is-window needs neither the CLI nor psql" || bad "is-window needs neither the CLI nor psql" "exit $rc: $out"

# --- review round 1: preflight proves the stack and pins its cwd ----------

printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.local"
printf 'select 6;\n' > "$pf/supabase/migrations/20260400500000_early.sql"
reset_log
out=$(pf_run "$pf")
rc=$?
if [ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && ! grep -qx 20260400500000 "$pfl" && echo "$out" | grep -q '55421' && ! echo "$out" | grep -q 'Ready'; then
  ok "preflight: a runtime on another loopback port refuses the start; the root stack is not migrated by proxy"
else
  bad "preflight: a runtime on another loopback port refuses the start; the root stack is not migrated by proxy" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"

reset_log
out=$(pf_run "$pf" STUB_LIST_GARBAGE=1)
rc=$?
[ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && ! echo "$out" | grep -q 'Ready' && echo "$out" | grep -q 'unrecognized' &&
  ok "preflight: an unrecognized listing refuses the start, applies nothing" ||
  bad "preflight: an unrecognized listing refuses the start, applies nothing" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"

# Invoked by absolute path from a worktree's cwd: the main checkout's file is
# applied, the worktree's is not, and the worktree exemption is not what
# decided it (the main checkout is what ran).
reset_log
out=$(cd "$work/pfwt" && (unset SUPABASE_URL LOCAL_SUPABASE_URL INK_MIGRATION_TARGET INK_SKIP_MIGRATIONS DB_MIGRATE_URL NODE_ENV; STUB_LEDGER="$pfl" node "$pf/scripts/preflight.mjs" 2>&1))
rc=$?
if [ "$rc" -eq 1 ] && grep -qx 20260400500000 "$pfl" && ! grep -qx 20260405000000 "$pfl" && echo "$out" | grep -q 'window migration is pending'; then
  ok "preflight by absolute path from a worktree cwd: acts on its own checkout (applies its file, stops at its window), never the cwd's"
else
  bad "preflight by absolute path from a worktree cwd: acts on its own checkout (applies its file, stops at its window), never the cwd's" "exit $rc: $out; ledger: $(cat "$pfl" | tr '\n' ' ')"
fi

# --- review round 1: prod:migrate is behind the same guard ----------------

prod_migrate_src="${PROD_MIGRATE_UNDER_TEST:-$root/scripts/prod-migrate.sh}"
cp "$prod_migrate_src" "$pf/scripts/prod-migrate.sh"
pm_run() {
  dir=$1
  shift
  (
    cd "$work" || exit 97
    unset SUPABASE_URL LOCAL_SUPABASE_URL INK_MIGRATION_TARGET INK_SKIP_MIGRATIONS DB_MIGRATE_URL NODE_ENV
    for kv in "$@"; do export "$kv"; done
    STUB_LEDGER="$pfl" bash "$dir/scripts/prod-migrate.sh" 2>&1
  )
}
reset_log
out=$(pm_run "$pf")
rc=$?
if [ "$rc" -eq 3 ] && ! calls | grep -q '^supabase db push' && ! calls | grep -q '^psql.* -f ' && ! grep -qx 20260403000000 "$pfl" &&
  echo "$out" | grep -q 'window migration' && echo "$out" | grep -q 'docs/runbooks/example-window.md'; then
  ok "prod:migrate, local target: a pending window migration is refused before any apply; db push is never reached"
else
  bad "prod:migrate, local target: a pending window migration is refused before any apply; db push is never reached" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=https://example.supabase.co\n' > "$pf/.env.local"
reset_log
out=$(pm_run "$pf")
rc=$?
[ "$rc" -eq 3 ] && ! calls | grep -q '^supabase db push' && echo "$out" | grep -q 'window migration' &&
  ok "prod:migrate, linked target: a pending window migration is refused before db push" ||
  bad "prod:migrate, linked target: a pending window migration is refused before db push" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
mv "$pf/supabase/migrations/20260403000000_w.sql" "$work/w.sql.parked"
reset_log
out=$(pm_run "$pf")
rc=$?
if [ "$rc" -eq 0 ] && calls | grep -q '^supabase db push --linked' && ! calls | grep -q '^psql.* -f ' && grep -qx 20260404000000 "$pfl"; then
  ok "prod:migrate, linked target, ordinary pending files: db push --linked runs, the local wrapper does not"
else
  bad "prod:migrate, linked target, ordinary pending files: db push --linked runs, the local wrapper does not" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"
printf 'select 9;\n' > "$pf/supabase/migrations/20260406000000_local_only.sql"
reset_log
out=$(pm_run "$pf")
rc=$?
if [ "$rc" -eq 0 ] && ! calls | grep -q '^supabase db push' && calls | grep -q '^psql.* -f .*20260406000000_local_only.sql' && grep -qx 20260406000000 "$pfl" &&
  calls | grep -q '^supabase status'; then
  ok "prod:migrate, local target, ordinary pending file: the wrapper applies it with the stack proven; db push is not used"
else
  bad "prod:migrate, local target, ordinary pending file: the wrapper applies it with the stack proven; db push is not used" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.local"
printf 'select 10;\n' > "$pf/supabase/migrations/20260407000000_local_two.sql"
reset_log
out=$(pm_run "$pf")
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^psql.* -f ' && ! grep -qx 20260407000000 "$pfl" && echo "$out" | grep -q '55421' &&
  ok "prod:migrate, local target on another port: refused, nothing applied" ||
  bad "prod:migrate, local target on another port: refused, nothing applied" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"
reset_log
out=$(pm_run "$pf" STUB_LIST_GARBAGE=1)
rc=$?
[ "$rc" -ne 0 ] && ! calls | grep -q '^supabase db push' && ! calls | grep -q '^psql.* -f ' &&
  ok "prod:migrate: an unrecognized listing is a refusal, not a best-effort apply" ||
  bad "prod:migrate: an unrecognized listing is a refusal, not a best-effort apply" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
mv "$work/w.sql.parked" "$pf/supabase/migrations/20260403000000_w.sql"

# --- review round 2 (Lumen, PR #675): the proof binds the connection ------

reset_log
printf 'select 11;\n' > "$pm/20260309000000_i.sql"
out=$(cd "$pend" && DB_MIGRATE_URL='postgresql://stub:ovSECRET@127.0.0.1:2/other' STUB_LEDGER="$pl" sh "$script" pending --for http://127.0.0.1:54321 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q 'DB_MIGRATE_URL' && ! echo "$out" | grep -q 'ovSECRET' && ! grep -qx 20260309000000 "$pl"; then
  ok "pending --for with DB_MIGRATE_URL set: refused before any database call, the override never printed"
else
  bad "pending --for with DB_MIGRATE_URL set: refused before any database call, the override never printed" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for http://127.0.0.1:54321 2>&1)
rc=$?
status_calls=$(calls | grep -c '^supabase status')
if [ "$rc" -eq 0 ] && [ "$status_calls" -eq 1 ] && grep -qx 20260309000000 "$pl" && calls | grep '^psql.* -f ' | grep -q "$STUB_DB_URL"; then
  ok "pending --for: one status answer supplies both the API URL checked and the DB URL used; one status call, the apply goes to that DB_URL"
else
  bad "pending --for: one status answer supplies both the API URL checked and the DB URL used; one status call, the apply goes to that DB_URL" "exit $rc, status calls $status_calls: $out; calls: $(calls | tr '\n' ' ')"
fi
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for 'http://fixture-user:SYNTHPW@127.0.0.1:55421/?token=SYNTHTOK#f' 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'SYNTHPW' && ! echo "$out" | grep -q 'SYNTHTOK' && echo "$out" | grep -q 'http://127.0.0.1:55421' && ! calls | grep -q '^psql'; then
  ok "pending --for a URL carrying userinfo and a query token: the mismatch names the origin only"
else
  bad "pending --for a URL carrying userinfo and a query token: the mismatch names the origin only" "exit $rc: (output withheld: $(echo "$out" | grep -c 'SYNTH') secret hits)"
fi
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for 'http://fixture-user:SYNTHPW@127.0.0.1:54321/?token=SYNTHTOK' 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ! echo "$out" | grep -q 'SYNTH' && ok "pending --for the stack's own origin dressed with userinfo and a query: same stack, applies, nothing printed" ||
  bad "pending --for the stack's own origin dressed with userinfo and a query: same stack, applies, nothing printed" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits"
out=$(sh "$script" safe-origin 'https://User:Pw@Host.Example:8443/path?x=1#y' 2>&1)
rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "https://host.example:8443" ] && ok "safe-origin keeps scheme, host and port only (the parser's origin, host lowercased)" || bad "safe-origin keeps scheme, host and port only (the parser's origin, host lowercased)" "exit $rc: $out"
# An unreadable pending file is a refusal for pending and for is-window.
printf 'select 12;\n' > "$pm/20260310000000_j.sql"
chmod 000 "$pm/20260310000000_j.sql"
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^psql.* -f ' && ! grep -qx 20260310000000 "$pl" && echo "$out" | grep -q 'cannot read' &&
  ok "pending: an unreadable file is a refusal, not an apply and not a non-window" ||
  bad "pending: an unreadable file is a refusal, not an apply and not a non-window" "exit $rc: $out"
out=$(cd "$pend" && sh "$script" is-window supabase/migrations/20260310000000_j.sql 2>&1)
rc=$?
[ "$rc" -eq 2 ] && ok "is-window: an unreadable file exits 2, never 1" || bad "is-window: an unreadable file exits 2, never 1" "exit $rc: $out"
chmod 644 "$pm/20260310000000_j.sql"

# --- review round 2: the runtime URL is the runtime's ----------------------
# The same layers as packages/api/src/config/env.ts: process env, then
# .env.local, then .env.{NODE_ENV} (or its .env.dev/.env.prod alias), then
# .env. LOCAL_SUPABASE_URL is nothing to the runtime and nothing here.

pf_env_reset() {
  rm -f "$pf/.env.local" "$pf/.env" "$pf/.env.development" "$pf/.env.dev" "$pf/.env.production" "$pf/.env.prod"
}
pf_env_reset
printf 'select 20;\n' > "$pf/supabase/migrations/20260400100000_layers.sql"
: > "$pf/.env.local"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env"
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.development"
reset_log
out=$(pf_run "$pf" NODE_ENV=development)
rc=$?
[ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && ! grep -qx 20260400100000 "$pfl" && echo "$out" | grep -q '55421' &&
  ok "preflight env layers: .env.development outranks .env, so the runtime's 55421 is what is proven (refused)" ||
  bad "preflight env layers: .env.development outranks .env, so the runtime's 55421 is what is proven (refused)" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
rm "$pf/.env.development"
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.dev"
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q '55421' &&
  ok "preflight env layers: the .env.dev alias counts for NODE_ENV=development (the default)" ||
  bad "preflight env layers: the .env.dev alias counts for NODE_ENV=development (the default)" "exit $rc: $out"
rm "$pf/.env.dev"
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.local"
reset_log
out=$(pf_run "$pf" LOCAL_SUPABASE_URL=http://127.0.0.1:54321)
rc=$?
[ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && echo "$out" | grep -q '55421' &&
  ok "preflight env layers: a shell LOCAL_SUPABASE_URL cannot redirect the proof; the runtime never reads it" ||
  bad "preflight env layers: a shell LOCAL_SUPABASE_URL cannot redirect the proof; the runtime never reads it" "exit $rc: $out"
reset_log
out=$(pf_run "$pf" SUPABASE_URL=http://127.0.0.1:54321)
rc=$?
# The fixture's window file is still pending behind the layered file, so a
# successful proof shows as: the layered file recorded, then the stop at
# the window (exit 1), exactly as the earlier window check.
[ "$rc" -eq 1 ] && grep -qx 20260400100000 "$pfl" && echo "$out" | grep -q 'window migration is pending' &&
  ok "preflight env layers: a shell SUPABASE_URL outranks .env.local, as it does for the server (applied, then the window stop)" ||
  bad "preflight env layers: a shell SUPABASE_URL outranks .env.local, as it does for the server (applied, then the window stop)" "exit $rc: $out"
printf 'select 21;\n' > "$pf/supabase/migrations/20260400200000_layers_two.sql"
: > "$pf/.env.local"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env"
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pf/.env.production"
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && grep -qx 20260400200000 "$pfl" && echo "$out" | grep -q 'window migration is pending' &&
  ok "preflight env layers: .env.production is not read under the default NODE_ENV; .env decides (applied, then the window stop)" ||
  bad "preflight env layers: .env.production is not read under the default NODE_ENV; .env decides (applied, then the window stop)" "exit $rc: $out"
printf 'select 22;\n' > "$pf/supabase/migrations/20260400300000_layers_three.sql"
reset_log
out=$(pf_run "$pf" NODE_ENV=production)
rc=$?
[ "$rc" -eq 1 ] && ! grep -qx 20260400300000 "$pfl" && echo "$out" | grep -q '55421' &&
  ok "preflight env layers: under NODE_ENV=production the .env.production value is what is proven (refused)" ||
  bad "preflight env layers: under NODE_ENV=production the .env.production value is what is proven (refused)" "exit $rc: $out"
pf_env_reset
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"
reset_log
out=$(pf_run "$pf" DB_MIGRATE_URL='postgresql://stub:ovSECRET@127.0.0.1:2/other')
rc=$?
[ "$rc" -eq 1 ] && ! calls | grep -q '^psql' && ! grep -qx 20260400300000 "$pfl" && ! echo "$out" | grep -q 'ovSECRET' && echo "$out" | grep -q 'DB_MIGRATE_URL' &&
  ok "preflight: an inherited DB_MIGRATE_URL refuses the start; the proof covers the connection, not only the API" ||
  bad "preflight: an inherited DB_MIGRATE_URL refuses the start; the proof covers the connection, not only the API" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && grep -qx 20260400300000 "$pfl" && echo "$out" | grep -q 'window migration is pending' &&
  ok "preflight: without the override the layered file applies and the run stops at the window as before" ||
  bad "preflight: without the override the layered file applies and the run stops at the window as before" "exit $rc: $out"
printf 'SUPABASE_URL=http://fixture-user:SYNTHPW@127.0.0.1:55421/?token=SYNTHTOK\n' > "$pf/.env.local"
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && ! echo "$out" | grep -q 'SYNTHPW' && ! echo "$out" | grep -q 'SYNTHTOK' && echo "$out" | grep -q '55421' &&
  ok "preflight: a runtime URL with userinfo and a token is refused by origin, and neither is printed" ||
  bad "preflight: a runtime URL with userinfo and a token is refused by origin, and neither is printed" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"

# --- review round 2: prod:migrate reads one listing ------------------------

cp "$prod_migrate_src" "$pf/scripts/prod-migrate.sh"
printf 'SUPABASE_URL=https://example.supabase.co\n' > "$pf/.env.local"
for kind in fail garbage; do
  reset_log
  out=$(pm_run "$pf" STUB_LIST_FAULT_FROM_CALL=2 STUB_LIST_FAULT_KIND=$kind)
  rc=$?
  lists=$(calls | grep -c '^supabase migration list')
  if [ "$rc" -eq 3 ] && ! calls | grep -q '^supabase db push' && ! grep -qx 20260403000000 "$pfl" && [ "$lists" -eq 1 ] && echo "$out" | grep -q 'window migration'; then
    ok "prod:migrate with a second listing that would $kind: there is no second listing; the one answer refuses the window"
  else
    bad "prod:migrate with a second listing that would $kind: there is no second listing; the one answer refuses the window" "exit $rc, listings $lists: $out; calls: $(calls | tr '\n' ' ')"
  fi
done
mv "$pf/supabase/migrations/20260403000000_w.sql" "$work/w.sql.parked"
reset_log
out=$(pm_run "$pf" STUB_LIST_FAULT_FROM_CALL=1 STUB_LIST_FAULT_KIND=garbage)
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^supabase db push' && echo "$out" | grep -q 'unknown listing' &&
  ok "prod:migrate: a listing that is not a listing is a refusal with the status named" ||
  bad "prod:migrate: a listing that is not a listing is a refusal with the status named" "exit $rc: $out"
# 20260407000000_local_two.sql is the file still pending on this target.
chmod 000 "$pf/supabase/migrations/20260407000000_local_two.sql"
reset_log
out=$(pm_run "$pf")
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^supabase db push' && ! grep -qx 20260407000000 "$pfl" && echo "$out" | grep -q 'could not judge' &&
  ok "prod:migrate: a pending file the marker check cannot read is a refusal, not a non-window" ||
  bad "prod:migrate: a pending file the marker check cannot read is a refusal, not a non-window" "exit $rc: $out"
chmod 644 "$pf/supabase/migrations/20260407000000_local_two.sql"
mv "$work/w.sql.parked" "$pf/supabase/migrations/20260403000000_w.sql"
printf 'SUPABASE_URL=http://fixture-user:SYNTHPW@127.0.0.1:54321/?token=SYNTHTOK\n' > "$pf/.env.local"
mv "$pf/supabase/migrations/20260403000000_w.sql" "$work/w.sql.parked"
printf 'select 23;\n' > "$pf/supabase/migrations/20260408000000_local_three.sql"
reset_log
out=$(pm_run "$pf")
rc=$?
[ "$rc" -eq 0 ] && grep -qx 20260408000000 "$pfl" && ! echo "$out" | grep -q 'SYNTH' && echo "$out" | grep -q 'for http://127.0.0.1:54321' &&
  ok "prod:migrate, local target: the runtime URL is logged as its origin only, and the apply goes through" ||
  bad "prod:migrate, local target: the runtime URL is logged as its origin only, and the apply goes through" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits; $out"
mv "$work/w.sql.parked" "$pf/supabase/migrations/20260403000000_w.sql"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"

# --- review round 3 (Lumen, PR #675): a parser decides where userinfo ends --

u='http://fixture-user:prefix@SYNTHSECRET@127.0.0.1:55421/path?token=SYNTHQUERY'
out=$(sh "$script" safe-origin "$u" 2>&1)
rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "http://127.0.0.1:55421" ] && ok "safe-origin: a password containing @ is userinfo up to the last @, as the URL parser reads it" ||
  bad "safe-origin: a password containing @ is userinfo up to the last @, as the URL parser reads it" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits"
out=$(sh "$script" safe-origin 'not a url' 2>&1)
rc=$?
[ "$rc" -eq 1 ] && [ -z "$out" ] && ok "safe-origin: an unparseable value prints nothing and exits 1" || bad "safe-origin: an unparseable value prints nothing and exits 1" "exit $rc: $out"
out=$(sh "$script" safe-origin 'mailto:someone@example.com' 2>&1)
rc=$?
[ "$rc" -eq 1 ] && [ -z "$out" ] && ok "safe-origin: an opaque origin is not an origin" || bad "safe-origin: an opaque origin is not an origin" "exit $rc: $out"
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for "$u" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'SYNTH' && echo "$out" | grep -q 'http://127.0.0.1:55421' && ! calls | grep -q '^psql'; then
  ok "pending --for a URL whose password contains @: refused by origin, neither secret printed"
else
  bad "pending --for a URL whose password contains @: refused by origin, neither secret printed" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits; calls: $(calls | tr '\n' ' ')"
fi
reset_log
out=$(cd "$pend" && STUB_LEDGER="$pl" sh "$script" pending --for 'not a url at all SYNTHRAW' 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && ! echo "$out" | grep -q 'SYNTHRAW' && echo "$out" | grep -q 'not a parseable URL' && ! calls | grep -q '^supabase status' && ! calls | grep -q '^psql'; then
  ok "pending --for an unparseable value: refused before the stack is even asked, the value not shown"
else
  bad "pending --for an unparseable value: refused before the stack is even asked, the value not shown" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
printf 'SUPABASE_URL=%s\n' "$u" > "$pf/.env.local"
reset_log
out=$(pf_run "$pf")
rc=$?
[ "$rc" -eq 1 ] && ! echo "$out" | grep -q 'SYNTH' && echo "$out" | grep -q '55421' && ! calls | grep -q '^psql' &&
  ok "preflight: a runtime URL whose password contains @ is refused by origin and nothing of it is printed" ||
  bad "preflight: a runtime URL whose password contains @ is refused by origin and nothing of it is printed" "exit $rc: $(echo "$out" | grep -c 'SYNTH') secret hits"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pf/.env.local"

# --- review round 3: the production entrypoint decides its mode first -----
# prod-direct.sh sources .env and .env.local into its own environment, runs
# the preflight, then checks for the server build. With no build in the
# fixture it stops right after the preflight, which is all that is needed:
# the proof must have read the production layer, with NODE_ENV unset by the
# caller, before any apply.

prod_direct_src="${PROD_DIRECT_UNDER_TEST:-$root/scripts/prod-direct.sh}"
pd="$work/pd"
mkdir -p "$pd/scripts/lib" "$pd/supabase/migrations"
cp "$pf/scripts/preflight.mjs" "$pf/scripts/migration-status.mjs" "$pf/scripts/db-migrate.sh" "$pd/scripts/"
cp "$prod_migrate_src" "$pd/scripts/prod-migrate.sh"
cp "$prod_direct_src" "$pd/scripts/prod-direct.sh"
cp "$guard" "$pd/scripts/lib/sql-transaction-control.awk"
cp "$root/scripts/lib/runtime-env.mjs" "$pd/scripts/lib/runtime-env.mjs"
ln -s "$root/node_modules" "$pd/node_modules"
(cd "$pd" && git init -q -b main && git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg") || bad "pd fixture" "git init failed"
: > "$pd/.env"
: > "$pd/.env.local"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pd/.env.development"
printf 'SUPABASE_URL=http://127.0.0.1:55421\n' > "$pd/.env.production"
printf 'select 30;\n' > "$pd/supabase/migrations/20260701000000_prod.sql"
pdl="$work/ledger-pd.txt"
: > "$pdl"
pd_run() {
  # $1 = script under $pd/scripts; the rest = VAR=value for this run.
  # NODE_ENV is unset on purpose: the entrypoint must decide it.
  sc=$1
  shift
  (
    cd "$pd" || exit 97
    unset SUPABASE_URL LOCAL_SUPABASE_URL INK_MIGRATION_TARGET INK_SKIP_MIGRATIONS DB_MIGRATE_URL NODE_ENV
    for kv in "$@"; do export "$kv"; done
    HOME="$work" TMPDIR="$work" STUB_LEDGER="$pdl" bash "$pd/scripts/$sc" 2>&1
  )
}
reset_log
out=$(pd_run prod-direct.sh)
rc=$?
if [ "$rc" -ne 0 ] && ! calls | grep -q '^psql' && ! grep -qx 20260701000000 "$pdl" && echo "$out" | grep -q '55421' && ! echo "$out" | grep -q 'Missing packages/api/dist'; then
  ok "prod:direct with NODE_ENV unset: the proof reads .env.production (55421) and refuses before any apply"
else
  bad "prod:direct with NODE_ENV unset: the proof reads .env.production (55421) and refuses before any apply" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
fi
reset_log
out=$(pd_run prod-migrate.sh)
rc=$?
[ "$rc" -eq 2 ] && ! calls | grep -q '^psql.* -f ' && ! calls | grep -q '^supabase db push' && echo "$out" | grep -q '55421' &&
  ok "prod:migrate with NODE_ENV unset: production's layer is what is proven; refused" ||
  bad "prod:migrate with NODE_ENV unset: production's layer is what is proven; refused" "exit $rc: $out; calls: $(calls | tr '\n' ' ')"
printf 'SUPABASE_URL=http://127.0.0.1:54321\n' > "$pd/.env.production"
reset_log
out=$(pd_run prod-direct.sh)
rc=$?
if [ "$rc" -eq 1 ] && grep -qx 20260701000000 "$pdl" && echo "$out" | grep -q 'Missing packages/api/dist'; then
  ok "prod:direct with .env.production naming the stack: the file is applied under production, then the missing build stops the start"
else
  bad "prod:direct with .env.production naming the stack: the file is applied under production, then the missing build stops the start" "exit $rc: $out; ledger: $(cat "$pdl" | tr '\n' ' ')"
fi
printf 'select 31;\n' > "$pd/supabase/migrations/20260702000000_prod_two.sql"
reset_log
out=$(pd_run prod-direct.sh NODE_ENV=development)
rc=$?
[ "$rc" -eq 1 ] && grep -qx 20260702000000 "$pdl" && echo "$out" | grep -q 'Missing packages/api/dist' &&
  ok "prod:direct with NODE_ENV set by the caller: the caller's value is kept (development's layer, 54321, applies)" ||
  bad "prod:direct with NODE_ENV set by the caller: the caller's value is kept (development's layer, 54321, applies)" "exit $rc: $out"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
