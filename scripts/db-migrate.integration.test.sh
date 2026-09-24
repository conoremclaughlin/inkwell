#!/bin/sh
# Contract test for scripts/db-migrate.sh against a REAL Postgres: the
# transaction really is atomic, the advisory lock really serialises two runs
# of one version, and a failure really leaves no row and no effect.
#
# Opt-in, and only ever against a disposable server. It creates its own
# database on the server named by DB_MIGRATE_TEST_ADMIN_URL, builds the
# ledger table there, runs the wrapper with DB_MIGRATE_URL pointing at it, and
# drops the database at the end. It must never be pointed at the shared local
# stack: use a throwaway container, for example
#
#   docker run -d --rm --name db-migrate-test -e POSTGRES_PASSWORD=test -p 55499:5432 postgres:15
#   DB_MIGRATE_TEST_ADMIN_URL='postgresql://postgres:test@127.0.0.1:55499/postgres' \
#     sh scripts/db-migrate.integration.test.sh
#   docker stop db-migrate-test
#
# Without DB_MIGRATE_TEST_ADMIN_URL it prints one line and exits 0, so CI,
# which has no database, passes it by.

set -u

admin=${DB_MIGRATE_TEST_ADMIN_URL:-}
if [ -z "$admin" ]; then
  echo "db-migrate.integration.test: skipped (set DB_MIGRATE_TEST_ADMIN_URL to a DISPOSABLE Postgres, never the shared stack)"
  exit 0
fi
case "$admin" in
  *54322*) echo "db-migrate.integration.test: refusing: that looks like the shared local stack's port" >&2; exit 2 ;;
esac
# Only a URL form is accepted, and its database is replaced outright: the
# path becomes the disposable database and any query string is dropped, so a
# ?dbname= or ?options= on the admin URL cannot redirect the run elsewhere.
case "$admin" in
  postgresql://*/* | postgres://*/*) ;;
  *) echo "db-migrate.integration.test: DB_MIGRATE_TEST_ADMIN_URL must be a postgresql://user:pw@host:port/db URL" >&2; exit 2 ;;
esac
case "$admin" in
  *dbname=*) echo "db-migrate.integration.test: refusing a dbname= parameter on the admin URL" >&2; exit 2 ;;
esac
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 2; }
# libpq reads the environment too. Nothing inherited may redirect a connection
# or add options: every connection here is exactly the URL it is given.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE \
  PGOPTIONS PGAPPNAME PGSSLMODE PGREQUIRESSL PGSSLKEY PGSSLCERT PGSSLROOTCERT PGCONNECT_TIMEOUT \
  PGTARGETSESSIONATTRS PGCLIENTENCODING PGDATESTYLE PGTZ PGGEQO PGSYSCONFDIR PGLOCALEDIR 2>/dev/null

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
script="$root/scripts/db-migrate.sh"

work=$(mktemp -d "${TMPDIR:-/tmp}/db-migrate-itest.XXXXXX") || exit 1
work=$(cd "$work" && pwd -P) || exit 1
# pid, wall clock and random bytes: a recycled pid or another host cannot
# collide with it, and a collision would only fail the CREATE anyway.
dbname="db_migrate_test_$$_$(date +%s)_$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
created=0
cleanup() {
  # Only a database this run created is dropped. A failed CREATE (a name
  # collision, say) must never lead to dropping what was already there.
  [ "$created" -eq 1 ] && psql "$admin" -X -q -c "DROP DATABASE IF EXISTS \"$dbname\" WITH (FORCE)" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s: %s\n' "$1" "$2"; }

psql "$admin" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$dbname\"" >/dev/null || {
  echo "could not create the disposable database" >&2
  exit 1
}
created=1
# The disposable database's URL: scheme, userinfo, host and port from the
# admin URL; the path is the new database; the query string is gone.
base=$(printf '%s' "$admin" | sed -E 's#^([a-z]+://[^/]*)/.*$#\1#')
url="$base/$dbname"
# Before any DDL, the connection must report the database this run owns.
actual=$(psql "$url" -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT current_database()") || {
  echo "could not connect to the disposable database" >&2
  exit 1
}
[ "$actual" = "$dbname" ] || {
  echo "refusing: the connection reports database '$actual', not the one this run created" >&2
  exit 1
}
psql "$url" -X -q -v ON_ERROR_STOP=1 -c "CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);" >/dev/null || {
  echo "could not build the ledger table" >&2
  exit 1
}
q() { psql "$url" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }

# A fixture checkout: the wrapper insists the file lives in <checkout>/supabase/migrations.
repo="$work/repo"
mkdir -p "$repo/supabase/migrations"
printf 'init\n' > "$work/msg"
(cd "$repo" && git init -q -b main && GIT_CONFIG_GLOBAL=/dev/null git -c user.name=fixture -c user.email=fixture@example.com commit -q --allow-empty -F "$work/msg") || exit 1
mig="$repo/supabase/migrations"
printf 'CREATE TABLE t_one (id int);\nINSERT INTO t_one VALUES (1);\n' > "$mig/20260101000000_one.sql"
printf 'CREATE TABLE t_two (id int);\nINSERT INTO t_two VALUES (%s);\n' "'not an int'" > "$mig/20260102000000_two.sql"
printf 'SELECT pg_sleep(2);\nCREATE TABLE t_three (id int);\nINSERT INTO t_three VALUES (3);\n' > "$mig/20260103000000_three.sql"
export DB_MIGRATE_URL="$url"

# --- atomic apply ------------------------------------------------------------
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
rows=$(q "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20260101000000' AND name = 'one'")
effect=$(q "SELECT count(*) FROM t_one")
stmt=$(q "SELECT statements[1] FROM supabase_migrations.schema_migrations WHERE version = '20260101000000'")
if [ "$rc" -eq 0 ] && [ "$rows" = 1 ] && [ "$effect" = 1 ] && [ "$stmt" = "$(cat "$mig/20260101000000_one.sql")" ]; then
  ok "a file and its ledger row commit together, the row holding the file text"
else
  bad "a file and its ledger row commit together, the row holding the file text" "exit $rc rows=$rows effect=$effect; $out"
fi

out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
rc=$?
rows=$(q "SELECT count(*) FROM supabase_migrations.schema_migrations")
effect=$(q "SELECT count(*) FROM t_one")
[ "$rc" -eq 0 ] && [ "$rows" = 1 ] && [ "$effect" = 1 ] && echo "$out" | grep -q 'already recorded' &&
  ok "a recorded version is skipped: no second row, no second effect" ||
  bad "a recorded version is skipped: no second row, no second effect" "exit $rc rows=$rows effect=$effect; $out"

# --- failure rolls everything back --------------------------------------------
out=$(cd "$repo" && sh "$script" apply supabase/migrations/20260102000000_two.sql 2>&1)
rc=$?
rows=$(q "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20260102000000'")
table=$(q "SELECT count(*) FROM pg_tables WHERE tablename = 't_two'")
[ "$rc" -eq 1 ] && [ "$rows" = 0 ] && [ "$table" = 0 ] && echo "$out" | grep -q 'rolled back' &&
  ok "a failing statement rolls back the table created before it and the ledger row" ||
  bad "a failing statement rolls back the table created before it and the ledger row" "exit $rc rows=$rows table=$table; $out"

# --- two runs of one version ---------------------------------------------------
(cd "$repo" && sh "$script" apply supabase/migrations/20260103000000_three.sql > "$work/a.out" 2>&1; echo $? > "$work/a.rc") &
(cd "$repo" && sh "$script" apply supabase/migrations/20260103000000_three.sql > "$work/b.out" 2>&1; echo $? > "$work/b.rc") &
wait
arc=$(cat "$work/a.rc")
brc=$(cat "$work/b.rc")
rows=$(q "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20260103000000'")
effect=$(q "SELECT count(*) FROM t_three")
wins=0
[ "$arc" -eq 0 ] && wins=$((wins + 1))
[ "$brc" -eq 0 ] && wins=$((wins + 1))
loser_out=$( [ "$arc" -ne 0 ] && cat "$work/a.out" || cat "$work/b.out")
if [ "$wins" -eq 1 ] && [ "$rows" = 1 ] && [ "$effect" = 1 ] && echo "$loser_out" | grep -q 'schema_migrations_pkey'; then
  ok "two concurrent runs of one version: exactly one commits, the other fails on the primary key, the file's effect happens once"
else
  bad "two concurrent runs of one version: exactly one commits, the other fails on the primary key, the file's effect happens once" "rcs=$arc/$brc rows=$rows effect=$effect; A: $(cat "$work/a.out" | tr '\n' ' '); B: $(cat "$work/b.out" | tr '\n' ' ')"
fi

# --- the connection string never appears in output ---------------------------
pw=$(printf '%s' "$admin" | sed -nE 's#^[a-z]+://[^:/@]*:([^@]*)@.*$#\1#p')
if [ -n "$pw" ]; then
  out=$(cd "$repo" && DB_MIGRATE_URL="$(printf '%s' "$url" | sed 's#/db_migrate_test#/nope_db_migrate_test#')" sh "$script" apply supabase/migrations/20260101000000_one.sql 2>&1)
  rc=$?
  hostport=$(printf '%s' "$admin" | sed -nE 's#^[a-z]+://[^@]*@([^/]*)/.*$#\1#p')
  [ "$rc" -eq 2 ] && ! echo "$out" | grep -qF "$pw" && ! echo "$out" | grep -qF "$hostport" &&
    ok "a failed ledger read prints neither the password nor the endpoint" ||
    bad "a failed ledger read prints neither the password nor the endpoint" "exit $rc: $out"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
