-- Migrate owner_agent_id (slug) → sb_id (UUID) for any rows that have the slug but not the UUID,
-- then drop the denormalized slug column.

-- Step 1: Backfill sb_id from owner_agent_id where sb_id is null
UPDATE task_groups tg
SET sb_id = ai.id
FROM agent_identities ai
WHERE tg.owner_agent_id IS NOT NULL
  AND tg.sb_id IS NULL
  AND ai.agent_id = tg.owner_agent_id
  AND ai.user_id = tg.user_id;

-- Step 2: Drop the column
ALTER TABLE task_groups DROP COLUMN IF EXISTS owner_agent_id;
