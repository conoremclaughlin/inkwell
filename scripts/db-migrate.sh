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
# This script runs ONE psql transaction: an advisory lock on the version, the
# ledger row (its primary key is the version, so a second run of the same
# file blocks on the lock and then fails the insert), then the file. Either
# all of it commits or none of it does. Any checkout, any order.
#
# Usage:
#   sh scripts/db-migrate.sh apply supabase/migrations/<version>_<name>.sql [...]
#   sh scripts/db-migrate.sh status
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

command -v supabase >/dev/null 2>&1 ||
  die "Supabase CLI not found on PATH (https://supabase.com/docs/guides/cli/getting-started)"
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git checkout"
root=$(cd "$common/.." && pwd -P) || die "could not resolve the repository root from $common"
checkout=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git work tree"

# Paths are compared physically (pwd -P): git reports the real path of the
# work tree, and on macOS a temp directory has two spellings.

# The running local stack's connection string. `supabase status` names its
# Docker containers after the directory, so a worktree cannot ask directly;
# it asks through the root. Everything else goes over this one connection.
db_url() {
  supabase status --workdir "$root" -o env 2>/dev/null |
    sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1
}

# The CLI prints a table: local version | remote version | time. A row with a
# remote version is recorded; the header and rule lines carry no 14-digit
# number and drop out. A failed listing is a refusal, never an empty ledger.
list_table() {
  supabase migration list --local --workdir "$checkout" 2>/dev/null
}

recorded_versions() {
  awk -F'|' 'NF >= 2 { gsub(/[[:space:]]/, "", $2); if (length($2) == 14 && $2 ~ /^[0-9]+$/) print $2 }'
}

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/db-migrate.XXXXXX") || die "could not create a temp directory"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

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

  table=$(list_table) || die "supabase migration list failed; is the local stack running? (refusing to apply without reading the ledger)"
  if printf '%s\n' "$table" | recorded_versions | grep -qx "$version"; then
    printf 'db-migrate: %s is already recorded; nothing to do\n' "$base"
    return 0
  fi

  url=$(db_url)
  [ -n "$url" ] ||
    die "the local Supabase stack is not running (supabase status gave no DB_URL). Start it from the root checkout with: supabase start   (NOT yarn supabase:local:setup, which resets the database)"

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
    command -v psql >/dev/null 2>&1 ||
      die "psql not found on PATH; install it (brew install libpq && brew link --force libpq)"
    status=0
    for f in "$@"; do
      apply_one "$f" || status=1
    done
    exit "$status"
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    table=$(list_table) || die "supabase migration list failed; is the local stack running?"
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
