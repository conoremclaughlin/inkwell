# Supabase Migrations Guide

This folder is the **single source of truth** for PCP schema changes.

## Naming

- Use UTC timestamp-prefixed files:
  - `YYYYMMDDHHmmss_short_description.sql`
- Generate with:
  - `date -u +%Y%m%d%H%M%S`

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
