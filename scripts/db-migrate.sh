#!/bin/sh
# Apply a migration file to the LOCAL Supabase stack and record it in the
# ledger under the file's own version.
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
# This script does the two steps those tools fuse: run the file's SQL in one
# transaction with psql, then `supabase migration repair --status applied`,
# which writes the row with the file's version, name and statements and does
# not care about other branches' rows. Any checkout, any order.
#
# Usage:
#   sh scripts/db-migrate.sh apply supabase/migrations/<version>_<name>.sql [...]
#   sh scripts/db-migrate.sh status
#
# Exit codes: 0 applied and recorded (or already recorded); 1 the SQL or the
# ledger write failed, and the message says which; 2 usage or environment.

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

# The running local stack's connection string. `supabase status` names its
# Docker containers after the directory, so a worktree cannot ask directly;
# it asks through the root. `migration list` and `migration repair` reach the
# same database by the port in supabase/config.toml, so they run here.
db_url() {
  supabase status --workdir "$root" -o env 2>/dev/null |
    sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1
}

# Paths are compared physically (pwd -P): git reports the real path of the
# work tree, and on macOS a temp directory has two spellings.

# The CLI prints a table: local version | remote version | time. A row with a
# remote version is recorded; the header and rule lines carry no 14-digit
# number and drop out.
list_table() {
  supabase migration list --local --workdir "$checkout" 2>/dev/null
}

recorded_versions() {
  list_table | awk -F'|' 'NF >= 2 { gsub(/[[:space:]]/, "", $2); if (length($2) == 14 && $2 ~ /^[0-9]+$/) print $2 }'
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
  dir=$(cd "$(dirname "$file")" && pwd -P) || die "cannot enter $(dirname "$file")"
  [ "$dir" = "$checkout/supabase/migrations" ] ||
    die "$base must live in $checkout/supabase/migrations for the ledger row to be written from it (found it in $dir)"

  if recorded_versions | grep -qx "$version"; then
    printf 'db-migrate: %s is already recorded; nothing to do\n' "$base"
    return 0
  fi

  url=$(db_url)
  [ -n "$url" ] ||
    die "the local Supabase stack is not running (supabase status gave no DB_URL); start it with: yarn supabase:local:setup"

  printf 'db-migrate: applying %s in one transaction\n' "$base"
  if ! psql "$url" -X -q -v ON_ERROR_STOP=1 -1 -f "$file"; then
    printf 'db-migrate: %s FAILED; the transaction rolled back and nothing was recorded\n' "$base" >&2
    return 1
  fi
  if ! supabase migration repair --local --workdir "$checkout" --status applied "$version" >/dev/null 2>&1; then
    printf 'db-migrate: %s applied but the ledger row was NOT written; run: supabase migration repair --local --status applied %s\n' "$base" "$version" >&2
    return 1
  fi
  printf 'db-migrate: recorded %s as %s\n' "$base" "$version"
}

case "$mode" in
  apply)
    [ "$#" -ge 1 ] || usage
    command -v psql >/dev/null 2>&1 ||
      die "psql not found on PATH; install it (brew install libpq && brew link --force libpq) or apply the file another way and record it with: supabase migration repair --local --status applied <version>"
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
