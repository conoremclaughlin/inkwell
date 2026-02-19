-- Drop the source CHECK constraint on memories table.
-- Source is stored as free-form text — the TypeScript type documents known values
-- but we don't need the DB to reject unknown ones. This lets agents use new source
-- categories (like 'reflection') without requiring a migration each time.

ALTER TABLE memories DROP CONSTRAINT IF EXISTS valid_source;
