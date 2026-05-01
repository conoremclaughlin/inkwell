-- Fix group_number default: DEFAULT 0 prevents the trigger from firing
-- because the trigger checks `IF NEW.group_number IS NULL`. With DEFAULT 0,
-- the value is never NULL on insert, so every group gets 0 and the second
-- insert for the same user violates the unique (user_id, group_number) index.
--
-- Fix: change default to NULL so the trigger auto-assigns the next number.

ALTER TABLE public.task_groups
  ALTER COLUMN group_number DROP NOT NULL,
  ALTER COLUMN group_number SET DEFAULT NULL;

-- Backfill any existing rows that have group_number = 0.
-- Assign sequential numbers per user ordered by created_at.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) AS rn
  FROM public.task_groups
  WHERE group_number = 0 OR group_number IS NULL
)
UPDATE public.task_groups t
SET group_number = numbered.rn
FROM numbered
WHERE t.id = numbered.id;
