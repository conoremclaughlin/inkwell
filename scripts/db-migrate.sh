#!/bin/sh
# Apply a migration file to the LOCAL Supabase stack and record it in the
# ledger under the file's own version, in the same transaction.
#
# The ledger (supabase_migrations.schema_migrations) is what `supabase
# migration list` compares the files against, and a row is only useful when
# its version is the file's version. Two ways of applying leave it wrong:
#
#   - the MCP apply_migration tool records the moment of application as the
#     version, so the row never matches the file name; by 2026-09-23 63 rows
#     had drifted that way and the startup warning meant to catch it was
#     itself broken;
#   - `supabase migration up` and `db push` refuse to run at all while the
#     ledger holds a version whose file is not in the current checkout, which
#     is the normal state whenever another branch applied its migration first.
#
# Every database operation here goes over ONE connection string, the running
# root stack's DB_URL: the recorded check, the transaction, and `status`.
# Nothing is resolved from the current checkout's config, so a worktree with
# a divergent supabase/config.toml cannot read one ledger and write another.
#
# The apply is one psql transaction: an advisory lock on the version, the
# ledger row (its primary key is the version, so a second run of the same
# file blocks on the lock and then fails the insert), then the file. Either
# all of it commits or none of it does. A file that carries its own
# transaction control (any spelling of BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT at
# the top level) or a psql meta-command is refused: psql's single-transaction
# mode does not cover transaction-control statements, so an inner COMMIT
# would commit the row and the partial file and leave a later failure
# un-rolled-back. The judgement is SQL-aware (lib/sql-transaction-control.awk):
# comments, strings and dollar-quoted bodies are invisible to it, so a
# function body's BEGIN and END do not count.
#
# Usage:
#   sh scripts/db-migrate.sh apply supabase/migrations/<version>_<name>.sql [...]
#   sh scripts/db-migrate.sh status
#
# DB_MIGRATE_URL, when set, is used instead of asking `supabase status`. It
# exists for the integration test (a disposable database) and for a stack
# the CLI cannot describe. The connection string is never printed; messages
# show it with the password replaced.
#
# Exit codes: 0 applied and recorded (or already recorded); 1 the transaction
# failed and rolled back; 2 usage or environment, before anything ran.

set -u

usage() {
  cat >&2 <<'USAGE'
usage: sh scripts/db-migrate.sh apply <supabase/migrations/FILE.sql> [...]
       sh scripts/db-migrate.sh status
USAGE
  exit 2
}

die() {
  printf 'db-migrate: %s\n' "$*" >&2
  exit 2
}

mode=${1:-}
[ -n "$mode" ] || usage
shift

here=$(cd "$(dirname "$0")" && pwd -P) || die "cannot locate the scripts directory"
guard="$here/lib/sql-transaction-control.awk"
[ -f "$guard" ] || die "missing $guard"
command -v psql >/dev/null 2>&1 ||
  die "psql not found on PATH; install it (brew install libpq && brew link --force libpq)"
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git checkout"
root=$(cd "$common/.." && pwd -P) || die "could not resolve the repository root from $common"
checkout=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git work tree"

need_cli() {
  command -v supabase >/dev/null 2>&1 ||
    die "Supabase CLI not found on PATH (https://supabase.com/docs/guides/cli/getting-started)"
}

# The connection string with its password replaced, for every message.
redact() {
  printf '%s' "$1" | sed -E 's#(://[^/@:]*):[^@]*@#\1:***@#'
}

# Paths are compared physically (pwd -P): git reports the real path of the
# work tree, and on macOS a temp directory has two spellings.

# The running root stack's connection string. `supabase status` names its
# Docker containers after the directory, so it is asked through the root; a
# worktree has no stack of its own.
db_url() {
  supabase status --workdir "$root" -o env 2>/dev/null |
    sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1
}

url=${DB_MIGRATE_URL:-}
if [ -z "$url" ]; then
  need_cli
  url=$(db_url)
  [ -n "$url" ] ||
    die "the local Supabase stack is not running (supabase status gave no DB_URL). Start it from the root checkout with: supabase start   (NOT yarn supabase:local:setup, which resets the database)"
fi
shown=$(redact "$url")

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/db-migrate.XXXXXX") || die "could not create a temp directory"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# How many ledger rows carry this version, read over the same connection the
# apply will use. A read that fails is a refusal, never "not recorded".
# $1 is exactly 14 digits by the time this runs (see apply_one), so it can
# sit inside the SQL text; psql does not interpolate variables into -c.
recorded_count() {
  psql "$url" -X -q -t -A -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$1'"
}

apply_one() {
  file=$1
  [ -f "$file" ] || die "no such file: $file"
  base=$(basename "$file")
  case "$base" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.sql) ;;
    *) die "migration files are named <YYYYMMDDHHmmss>_<name>.sql (date -u +%Y%m%d%H%M%S); got $base" ;;
  esac
  version=${base%%_*}
  name=${base#*_}
  name=${name%.sql}
  case "$name" in
    *[!A-Za-z0-9_]*) die "the name part of $base may only use letters, digits and underscores" ;;
  esac
  dir=$(cd "$(dirname "$file")" && pwd -P) || die "cannot enter $(dirname "$file")"
  [ "$dir" = "$checkout/supabase/migrations" ] ||
    die "$base must live in $checkout/supabase/migrations (found it in $dir)"
  findings=$(awk -f "$guard" "$file" 2>&1)
  case $? in
    0) ;;
    1)
      printf 'db-migrate: %s carries its own transaction control or a psql meta-command; remove it:\n%s\n' "$base" "$findings" >&2
      die "the wrapper runs the file inside one transaction with its ledger row, and psql's single-transaction mode does not cover transaction-control statements, so an inner COMMIT would record the row and commit a partial file (a BEGIN/COMMIT pair is also redundant here)"
      ;;
    *) die "could not scan $base for transaction control: $findings" ;;
  esac

  count=$(recorded_count "$version") || die "could not read the ledger over $shown (refusing to apply without it)"
  case "$count" in
    0) ;;
    [1-9]*)
      printf 'db-migrate: %s is already recorded; nothing to do\n' "$base"
      return 0
      ;;
    *) die "unexpected ledger answer for $version: '$count'" ;;
  esac

  # Lock, then row, then file, in one transaction. The lock serialises two
  # runs of the same version; the loser then fails the insert on the primary
  # key and rolls back before its copy of the file runs. Values reach SQL as
  # psql variables (:'v'), never by shell interpolation into SQL text.
  cat > "$tmpdir/record.sql" <<'SQL'
SELECT pg_advisory_xact_lock(hashtext('db-migrate'), hashtext(:'version'));
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES (:'version', :'name', ARRAY[:'content']);
SQL
  content=$(cat "$file") || die "cannot read $file"

  printf 'db-migrate: applying %s and its ledger row in one transaction\n' "$base"
  if ! psql "$url" -X -q -v ON_ERROR_STOP=1 -1 \
    -v "version=$version" -v "name=$name" -v "content=$content" \
    -f "$tmpdir/record.sql" -f "$file"; then
    printf 'db-migrate: %s FAILED; the transaction rolled back and nothing was recorded (a duplicate-key error on schema_migrations_pkey means another run recorded %s first)\n' "$base" "$version" >&2
    return 1
  fi
  printf 'db-migrate: recorded %s as %s\n' "$base" "$version"
}

case "$mode" in
  apply)
    [ "$#" -ge 1 ] || usage
    status=0
    for f in "$@"; do
      apply_one "$f" || status=1
    done
    exit "$status"
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    need_cli
    # The CLI prints a table: local version | remote version | time. Bound to
    # the same endpoint as apply; the files come from this checkout.
    table=$(supabase migration list --db-url "$url" --workdir "$checkout" 2>/dev/null) ||
      die "supabase migration list failed over $shown"
    printf '%s\n' "$table"
    printf '%s\n' "$table" | awk -F'|' '
      NF >= 2 {
        gsub(/[[:space:]]/, "", $1); gsub(/[[:space:]]/, "", $2)
        l = (length($1) == 14 && $1 ~ /^[0-9]+$/); r = (length($2) == 14 && $2 ~ /^[0-9]+$/)
        if (l && r) both++; else if (l) pending++; else if (r) elsewhere++
      }
      END {
        printf "db-migrate: %d recorded, %d pending in this checkout, %d applied from another checkout\n", both, pending, elsewhere
        if (pending) print "db-migrate: apply pending files with: yarn db:migrate supabase/migrations/<file>"
      }'
    ;;
  *) usage ;;
esac
