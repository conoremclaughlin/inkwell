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
# function body's BEGIN and END do not count. It runs under LC_ALL=C so it
# lexes bytes the way PostgreSQL does, identically on every machine.
#
# `pending` applies every file the ledger lacks, in version order, one
# transaction each. `yarn dev` and `yarn prod:direct` run it from the main
# checkout before the servers start, so a restart cannot outrun its migrations
# again: on 2026-09-24 the server came up on a release whose cutover had not
# been applied, and every poll failed on a renamed function until the window
# was run. A file whose first ten lines carry `-- db-migrate: window [<runbook>]`
# is a stop-the-world migration: `pending` stops in front of it (exit 3) and
# names the runbook, and `apply` takes it only with --window, which says the
# operator is inside that window (writers stopped, snapshot taken). Nothing
# behind it is applied until it is.
#
# `pending --for <SUPABASE_URL>` first proves the stack: one `supabase status`
# answer supplies both the API_URL and the DB_URL, the API_URL must be the
# URL given (same origin: scheme, host, port), and the transaction then goes
# to the DB_URL of that same answer. DB_MIGRATE_URL is refused under --for:
# an automatic apply cannot take its connection from anywhere the proof did
# not cover. The startup preflight passes the runtime's effective
# SUPABASE_URL, so an automatic apply can only ever land on the database the
# server is about to use; a runtime on another loopback port is refused, not
# migrated by proxy. Diagnostics name origins only, never userinfo, query or
# fragment. The listing itself is validated whole before any row is acted on
# (header present, every row well formed), the same contract as
# migration-status.mjs: unrecognized output is a refusal, never "nothing
# pending".
#
# Usage:
#   sh scripts/db-migrate.sh apply [--window] supabase/migrations/<version>_<name>.sql [...]
#   sh scripts/db-migrate.sh pending [--dry-run] [--for <SUPABASE_URL>]
#   sh scripts/db-migrate.sh status
#   sh scripts/db-migrate.sh is-window supabase/migrations/<file>.sql
#   sh scripts/db-migrate.sh safe-origin <url>
#
# `--for`, `safe-origin` and `is-window` need node on the PATH (the URL
# parser); `apply` and `status` do not.
#
# DB_MIGRATE_URL, when set, is used instead of asking `supabase status`. It
# exists for the integration test (a disposable database) and for a stack
# the CLI cannot describe. The connection string is never printed, in any
# part: a password can sit in the userinfo, in a ?password= parameter, or in
# keyword/value form, so no message names the endpoint at all.
#
# Exit codes: 0 applied and recorded (or already recorded, or nothing pending);
# 1 a transaction failed and rolled back; 2 usage, environment, or a refusal
# before anything ran; 3 `pending` stopped in front of a window migration.

set -u

usage() {
  cat >&2 <<'USAGE'
usage: sh scripts/db-migrate.sh apply [--window] <supabase/migrations/FILE.sql> [...]
       sh scripts/db-migrate.sh pending [--dry-run] [--for <SUPABASE_URL>]
       sh scripts/db-migrate.sh status
       sh scripts/db-migrate.sh is-window <supabase/migrations/FILE.sql>
       sh scripts/db-migrate.sh safe-origin <url>
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

# A window migration announces itself in its first ten lines:
#   -- db-migrate: window docs/runbooks/<name>.md
# Ten lines, so the marker is visible without opening the file and a runbook
# that merely mentions the phrase further down does not count. The text after
# "window" is the runbook, named in every refusal.
is_window() {
  head -n 10 "$1" | grep -qE '^--[[:space:]]*db-migrate:[[:space:]]*window([[:space:]]|$)'
}
window_runbook() {
  head -n 10 "$1" | sed -n 's/^--[[:space:]]*db-migrate:[[:space:]]*window[[:space:]]*//p' | head -1 | sed 's/[[:space:]]*$//'
}

# `is-window FILE`: exit 0 and print the runbook (possibly empty) when the
# file carries the marker, 1 when it does not, 2 when it cannot be read. For
# other scripts (prod-migrate.sh) so the marker has one definition. A file
# that cannot be read is a refusal, never "not a window".
if [ "$mode" = "is-window" ]; then
  [ "$#" -eq 1 ] || usage
  [ -f "$1" ] || die "no such file: $1"
  [ -r "$1" ] || die "cannot read $1"
  if is_window "$1"; then
    window_runbook "$1"
    exit 0
  fi
  exit 1
fi

# The part of a URL that is safe to print: its origin (scheme, host, port),
# as the WHATWG URL parser in node defines it. Userinfo, path, query and
# fragment are gone, and the parser, not a regex, decides where userinfo
# ends: a password may itself contain "@", and the last one is the
# delimiter. A value the parser rejects, or one with an opaque origin, is
# not a URL for our purposes: nothing is printed and the status is 1, so a
# caller refuses rather than guessing what to show.
safe_origin() {
  node -e '
    let origin = "";
    try {
      const u = new URL(process.argv[1]);
      if (u.origin !== "null") origin = u.origin;
    } catch {
      origin = "";
    }
    process.stdout.write(origin);
    process.exit(origin ? 0 : 1);
  ' "$1" 2>/dev/null
}

# `safe-origin URL`: the same, for other scripts' messages: the origin and
# exit 0, or nothing and exit 1.
if [ "$mode" = "safe-origin" ]; then
  [ "$#" -eq 1 ] || usage
  if origin=$(safe_origin "$1"); then
    printf '%s\n' "$origin"
    exit 0
  fi
  exit 1
fi

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

# Paths are compared physically (pwd -P): git reports the real path of the
# work tree, and on macOS a temp directory has two spellings.

# The running root stack's connection string. `supabase status` names its
# Docker containers after the directory, so it is asked through the root; a
# worktree has no stack of its own.
db_url() {
  supabase status --workdir "$root" -o env 2>/dev/null |
    sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1
}

# The connection every mode uses: DB_MIGRATE_URL when set, else the root
# stack's DB_URL. Resolved by the mode that needs it, so that `pending --for`
# can bind its own connection to the same status answer as its proof.
url=''
connect() {
  url=${DB_MIGRATE_URL:-}
  if [ -z "$url" ]; then
    need_cli
    url=$(db_url)
    [ -n "$url" ] ||
      die "the local Supabase stack is not running (supabase status gave no DB_URL). Start it from the root checkout with: supabase start   (NOT yarn supabase:local:setup, which resets the database)"
  fi
}

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

# The listing `supabase migration list` prints, judged whole. Lines before
# the `Local | Remote` header are the CLI's chatter and are skipped; after it,
# every non-blank line that is not the rule must be a row: an optional
# 14-digit version, a pipe, an optional 14-digit version, a pipe, then the
# time, with at least one version. One line that is not is a refusal for the
# whole listing (exit 1, the line on stderr); no header at all is the same.
# Rows come out classified: "L v" local-only (pending), "R v" remote-only
# (applied from another checkout), "B v" both. This is the contract
# migration-status.mjs enforces for the startup listing, in awk so the
# wrapper has no second opinion about what a listing is.
classify_table() {
  awk -F'|' '
    function trim(x) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", x); return x }
    function isver(x) { return (x ~ /^[0-9]+$/ && length(x) == 14) }
    !header {
      if ($0 ~ /^[[:space:]]*Local[[:space:]]*\|[[:space:]]*Remote[[:space:]]*\|/) header = 1
      next
    }
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*-+[[:space:]]*\|[[:space:]]*-+[[:space:]]*\|/ { next }
    {
      l = trim($1); r = trim($2); t = (NF >= 3) ? trim($3) : ""
      if (NF < 3 || t == "" || (l != "" && !isver(l)) || (r != "" && !isver(r)) || (l == "" && r == "")) {
        printf "malformed row: %s\n", substr(trim($0), 1, 60) > "/dev/stderr"
        bad = 1
        exit 1
      }
      if (l != "" && r != "") print "B " l
      else if (l != "") print "L " l
      else print "R " r
    }
    END {
      if (bad) exit 1
      if (!header) { print "no Local | Remote header" > "/dev/stderr"; exit 1 }
    }'
}

# Origins are compared canonically: loopback spellings name the same machine,
# and the port is what tells two local stacks apart. Only origins reach this
# (see safe_origin), so userinfo, path, query and fragment can never make two
# different stacks look alike or the same stack look different.
canon_origin() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E -e 's#://localhost(:|$)#://127.0.0.1\1#' -e 's#://\[::1\](:|$)#://127.0.0.1\1#'
}

# One value out of a `supabase status -o env` answer held in $1.
status_value() {
  printf '%s\n' "$1" | sed -n 's/^'"$2"'="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1
}

allow_window=0

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
  if is_window "$file"; then
    runbook=$(window_runbook "$file")
    if [ "$allow_window" -ne 1 ]; then
      printf 'db-migrate: %s is a window migration (stop-the-world): it is applied inside its runbook'\''s window, with writers stopped and a snapshot taken%s\n' \
        "$base" "${runbook:+; runbook: $runbook}" >&2
      die "run it deliberately, from inside that window, with: yarn db:migrate --window $file"
    fi
    printf 'db-migrate: %s is a window migration; --window given, so writers are stopped and the snapshot is taken%s\n' \
      "$base" "${runbook:+ (runbook: $runbook)}"
  fi
  # Byte-wise, in the C locale, on every machine: see the guard's header.
  findings=$(LC_ALL=C awk -f "$guard" "$file" 2>&1)
  case $? in
    0) ;;
    1)
      printf 'db-migrate: %s carries its own transaction control or a psql meta-command; remove it:\n%s\n' "$base" "$findings" >&2
      die "the wrapper runs the file inside one transaction with its ledger row, and psql's single-transaction mode does not cover transaction-control statements, so an inner COMMIT would record the row and commit a partial file (a BEGIN/COMMIT pair is also redundant here)"
      ;;
    *) die "could not scan $base for transaction control: $findings" ;;
  esac

  count=$(recorded_count "$version") || die "could not read the ledger (refusing to apply without it; the endpoint is not shown because it can carry a password)"
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
    if [ "${1:-}" = "--window" ]; then
      allow_window=1
      shift
    fi
    [ "$#" -ge 1 ] || usage
    connect
    status=0
    for f in "$@"; do
      apply_one "$f" || status=1
    done
    exit "$status"
    ;;
  pending)
    dry=0
    expect=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dry-run) dry=1; shift ;;
        --for)
          [ -n "${2:-}" ] || usage
          expect=$2
          shift 2
          ;;
        *) usage ;;
      esac
    done
    need_cli
    if [ -n "$expect" ]; then
      # Prove the stack before anything else, and bind the connection to the
      # proof: one status answer gives the API_URL that must match the runtime
      # and the DB_URL the transaction will use. An override would let the
      # write land somewhere the proof never looked, so it is refused here.
      [ -z "${DB_MIGRATE_URL:-}" ] ||
        die "DB_MIGRATE_URL is set, but an automatic apply (--for) proves its target through supabase status and takes the database endpoint from that same answer; unset DB_MIGRATE_URL, or run without --for. Nothing applied."
      # Only origins are compared or printed. A runtime URL the parser rejects
      # is a refusal on its own, and its value is not shown.
      expect_origin=$(safe_origin "$expect") ||
        die "the runtime's SUPABASE_URL is not a parseable URL, so no stack can be proven to be its own; nothing applied (the value is not shown)"
      stack=$(supabase status --workdir "$root" -o env 2>/dev/null) ||
        die "the local Supabase stack is not running (supabase status failed). Start it from the root checkout with: supabase start   (NOT yarn supabase:local:setup, which resets the database). Nothing applied."
      actual=$(status_value "$stack" API_URL)
      url=$(status_value "$stack" DB_URL)
      [ -n "$actual" ] || die "the local Supabase stack did not report an API_URL, so it cannot be matched against $expect_origin; nothing applied"
      [ -n "$url" ] || die "the local Supabase stack did not report a DB_URL in the same answer as its API_URL; nothing applied"
      actual_origin=$(safe_origin "$actual") ||
        die "the local Supabase stack's API_URL is not a parseable URL; nothing applied"
      if [ "$(canon_origin "$actual_origin")" != "$(canon_origin "$expect_origin")" ]; then
        die "the runtime's SUPABASE_URL is $expect_origin but the local stack advertises $actual_origin; refusing to apply migrations to a stack the server does not use (a second stack on another port?). Nothing applied."
      fi
    else
      connect
    fi
    # Same table as `status`, same endpoint, judged whole before any row is
    # acted on; a local-only row is a gap.
    table=$(supabase migration list --db-url "$url" --workdir "$checkout" 2>/dev/null) ||
      die "supabase migration list failed (the endpoint is not shown because it can carry a password)"
    rows=$(printf '%s\n' "$table" | classify_table 2>"$tmpdir/parse.err") ||
      die "unrecognized \`supabase migration list\` output ($(cat "$tmpdir/parse.err")); nothing applied"
    versions=$(printf '%s\n' "$rows" | awk '$1 == "L" { print $2 }' | sort)
    if [ -z "$versions" ]; then
      printf 'db-migrate: nothing pending in this checkout\n'
      exit 0
    fi
    for v in $versions; do
      set -- "$checkout"/supabase/migrations/"$v"_*.sql
      { [ "$#" -eq 1 ] && [ -f "$1" ]; } ||
        die "expected exactly one file for pending version $v under supabase/migrations (found $#); nothing after it was applied"
      f=$1
      base=$(basename "$f")
      [ -r "$f" ] || die "cannot read $base; nothing after it was applied"
      if is_window "$f"; then
        runbook=$(window_runbook "$f")
        rest=$(printf '%s\n' "$versions" | awk -v v="$v" '$0 > v' | wc -l | tr -d ' ')
        printf 'db-migrate: stopped at %s: a window migration (stop-the-world) is never applied by pending or at startup. Run its window%s, then run pending again; %s later file(s) wait behind it.\n' \
          "$base" "${runbook:+ (runbook: $runbook)}" "$rest" >&2
        exit 3
      fi
      if [ "$dry" -eq 1 ]; then
        printf 'db-migrate: would apply %s\n' "$base"
        continue
      fi
      apply_one "$f" || exit 1
    done
    [ "$dry" -eq 1 ] && printf 'db-migrate: dry run; nothing was applied\n'
    exit 0
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    connect
    need_cli
    # The CLI prints a table: local version | remote version | time. Bound to
    # the same endpoint as apply; the files come from this checkout.
    table=$(supabase migration list --db-url "$url" --workdir "$checkout" 2>/dev/null) ||
      die "supabase migration list failed (the endpoint is not shown because it can carry a password)"
    printf '%s\n' "$table"
    rows=$(printf '%s\n' "$table" | classify_table 2>"$tmpdir/parse.err") ||
      die "unrecognized \`supabase migration list\` output ($(cat "$tmpdir/parse.err"))"
    printf '%s\n' "$rows" | awk '
      $1 == "B" { both++ } $1 == "L" { pending++ } $1 == "R" { elsewhere++ }
      END {
        printf "db-migrate: %d recorded, %d pending in this checkout, %d applied from another checkout\n", both, pending, elsewhere
        if (pending) print "db-migrate: apply pending files with: yarn db:migrate supabase/migrations/<file>"
      }'
    ;;
  *) usage ;;
esac
