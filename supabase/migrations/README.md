# Supabase Migrations Guide

This folder is the **single source of truth** for PCP schema changes.

## Naming

- Use UTC timestamp-prefixed files:
  - `YYYYMMDDHHmmss_short_description.sql`
- Generate with:
  - `date -u +%Y%m%d%H%M%S`

## Applying a migration

The local stack (`SUPABASE_URL` in `.env.local`, port 54321) keeps a ledger,
`supabase_migrations.schema_migrations`, with one row per applied file, and
`supabase migration list --local` compares the files in your checkout against
it. A row is only useful when its version is the file's version. Everything in
this section exists to keep that true.

```bash
yarn db:migrate supabase/migrations/20260916024540_memory_embedding_atomic_swap.sql
yarn db:migrate:status
yarn db:migrate:pending
```

`db:migrate` (`scripts/db-migrate.sh`) runs one psql transaction: an advisory
lock on the version, the ledger row (version, name, and the file text as its
one statement), then the file. Either all of it commits or none of it does, and
two runs of the same file cannot both succeed: the second waits on the lock and
then fails the row's primary key before its copy of the file runs. Every
database operation, the recorded check, the transaction and `status`, goes over
the running root stack's connection string (`supabase status` asked through the
root), never an endpoint resolved from the current checkout's config, so a
worktree cannot read one ledger and write another. It works from any worktree,
in any order, and skips a version the ledger already has. Several files can be
given at once; each is its own transaction.

A file must not carry its own transaction control at the top level, in any
spelling (`BEGIN`, `START TRANSACTION`, `COMMIT`, `COMMIT WORK`, `END`,
`ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ABORT`, `PREPARE TRANSACTION`), nor a
psql meta-command (`\connect`, `\i`, ...); the wrapper refuses it and names
the statement. psql's single-transaction mode does not cover
transaction-control statements: an inner `COMMIT` would commit the ledger row
and everything before it, and a failure later in the file would not roll that
back, which is precisely the recorded-but-partially-applied state the wrapper
exists to prevent. The judgement is SQL-aware
(`scripts/lib/sql-transaction-control.awk`): comments, string literals and
dollar-quoted bodies are invisible to it, so the `BEGIN`/`END` of a plpgsql
function is not transaction control and a `COMMIT;` inside a comment is not
either. `BEGIN ATOMIC` bodies are refused outright; use a dollar-quoted body.
Two older files in this directory do carry a top-level `BEGIN`/`COMMIT`; they
are already applied and do not go through the wrapper.

`DB_MIGRATE_URL` overrides the connection string (the wrapper then does not ask
`supabase status`). It exists for `scripts/db-migrate.integration.test.sh`,
which builds a disposable database on a throwaway Postgres and proves the
contract for real: one transaction, one effect under concurrency, nothing left
behind by a failure. That test is opt-in and must never be pointed at the
shared stack; the file's header shows the `docker run` it expects. No message
ever names the endpoint: a password can sit in the userinfo, in a `?password=`
parameter, or in keyword/value form, so the connection string is never printed.

If the stack is not running, start it from the root checkout with
`supabase start`. Do not reach for `yarn supabase:local:setup` for that: it
runs `supabase db reset` and discards every row of live data.

`db:migrate:pending` applies every file the ledger lacks, in version order,
one transaction each, and `yarn dev` and `yarn prod:direct` run it from the
main checkout before the servers start. The restart is the deploy, and a
server must not come up on a schema behind its code: on 2026-09-24 the main
server was restarted on a release whose three migrations had not been applied,
the startup check printed them as a warning and let it start, and every
channel poll then failed on a renamed function until the window was run.
`yarn dev:no-migrations` (`INK_SKIP_MIGRATIONS=1`) skips the step on purpose,
prints what is pending, and starts anyway. A worktree's server never applies
anything to the shared stack; it warns, as before. A linked (hosted) target is
not driven by the wrapper: pending there refuses the start and points at
`yarn linked:migrate`.

### Window migrations

A migration that needs writers stopped, a snapshot, or a manifest loaded first
announces itself in its first ten lines:

```sql
-- db-migrate: window docs/runbooks/<name>.md
```

`pending`, and so startup, stops in front of such a file with exit 3, names the
runbook, and applies nothing behind it. `apply` takes it only as
`yarn db:migrate --window <file>`, which says the operator is inside that
window. `20260913090000_inkmail_thread_scope_cutover.sql` is the first, and
its runbook is `docs/runbooks/inkmail-thread-scope-cutover.md`.

Two other ways of applying exist, and both leave the ledger wrong:

- The MCP `apply_migration` tool records the moment of application as the
  version, not the file name. On 2026-09-23 the ledger held 129 rows for 140
  files: 63 rows carried a version a few seconds to a day off the file's, 15
  files had no row at all (applied through `execute_sql`), and one data
  migration, `mark_bridge_identities`, had never run, so two relay identities
  had been misclassified in routing for five weeks. The startup warning that
  should have reported 78 pending files had been printing "unable to
  determine" for months, because it asked the CLI for JSON and got a table.
- `supabase migration up` and `supabase db push` refuse to run while the ledger
  holds a version whose file is not in your checkout. That is the normal state
  whenever another branch has applied its migration first, so on a shared stack
  they only work from a checkout that has every applied file, which is never
  a feature branch.

## Order

Postgres does not care what order migrations run in; only dependencies between
files do, and a series written in sequence carries its order in the stamps.
The Supabase CLI does care: `migration up` and `db push` apply pending files in
version order and refuse a file stamped earlier than the newest applied one
unless `--include-all` is given. `db:migrate` has no such rule.

The one place order is enforced is a build from an empty database, which runs
every file in name order. A file stamped earlier than one it depends on fails
there and nowhere else. The check is a shadow build (Docker, about 30 seconds):

```bash
supabase db diff --local --schema public
```

It applies all files in order to a throwaway database and prints the schema
difference against the live one. An empty diff means the files on disk are a
complete, correctly ordered description of the live schema. On 2026-09-23 all
140 applied cleanly and the only differences were columns from a branch not yet
merged, plus comment lines the MCP tool had stripped from function bodies.
Run it when a migration depends on another, when you re-stamp a file, and
before a release. A migration that has sat on a branch for weeks should be
re-stamped (`date -u +%Y%m%d%H%M%S`, rename the file) before it merges, so its
position in a fresh build matches the order it was really applied in.

## If the ledger is wrong

`supabase migration repair --local --status applied <version>` adds a row (with
name and statements from the file); `--status reverted <version>` removes one.
Both edit the ledger only and run no SQL. Use them when a file was applied by
hand, or when a branch that applied a migration was abandoned. Rows applied from
other people's unmerged branches show up as "applied from another checkout" in
`yarn db:migrate:status` and in the `yarn dev` startup line; leave them alone.

Never `supabase db reset` against the shared local stack. It rebuilds the
database from the files and discards every row of live data.

## `updated_at` trigger standard (important)

PCP uses one canonical trigger function for `updated_at`:

- `public.update_updated_at_column()`

When adding a table with `updated_at`, use:

```sql
CREATE TRIGGER <table>_updated_at
  BEFORE UPDATE ON public.<table>
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
```

Do **not** introduce alternate helper names like `update_updated_at()`.

### `NOW()` vs `clock_timestamp()`

`public.update_updated_at_column()` currently uses `NOW()` intentionally.

- `NOW()` / `current_timestamp` is stable within a transaction.
- This gives consistent audit semantics for multi-row updates in one transaction.

If we ever need per-row wall-clock variance inside the same transaction, we can
switch to `clock_timestamp()`, but that should be an explicit product/audit
decision (not a one-off migration change).

## Editing old migrations

- Prefer adding a new forward-only migration.
- If a historical migration has a typo that breaks **fresh bootstrap** (from empty DB), patch that file and add a follow-up normalization migration for already-applied environments.

## Before opening a PR

- Grep for inconsistent trigger helpers:

```bash
rg -n "update_updated_at\\(|update_updated_at_column\\(" supabase/migrations
```

- Run project checks:
  - `yarn type-check`
  - relevant test suites for touched packages
