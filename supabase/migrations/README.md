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
```

`db:migrate` (`scripts/db-migrate.sh`) runs the file with psql in one
transaction, then `supabase migration repair --local --status applied <version>`,
which writes the row with the file's version, name and statements. It works from
any worktree (the CLI reaches the stack by the port in `supabase/config.toml`),
in any order, and skips a version the ledger already has. Several files can be
given at once; each is its own transaction. Do not write `BEGIN`/`COMMIT` into a
migration file: the wrapper, like the CLI, already wraps the file, and an inner
pair only produces "there is already a transaction in progress" warnings.

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
