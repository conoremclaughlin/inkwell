-- Re-key the live-ephemeral fence onto canonical runtime status.
--
-- 20260824222751 added uniq_live_ephemeral_studio_per_parent_thread with the
-- predicate `cleaned_at IS NULL AND archived_at IS NULL`. Every runtime path
-- that decides whether a studio is usable — the overflow reuse preflight, lease
-- admission, routing — asks `status IN ('active','idle')` and never reads those
-- timestamps. Two definitions of "live" over one table is the bug, not a style
-- difference (PR #537 round 3, Lumen):
--
--   1. That migration's dedupe stamped archived_at on losers but left
--      status='active'. Those rows stayed routable and reusable while dropping
--      out of the index — so the fence permitted exactly the split it exists to
--      prevent.
--   2. Reviving a row whose archived_at was set brings it back to
--      status='active' but the timestamp survived, so the revived, runtime-live
--      row sat outside the fence and could coexist with another variant.
--
-- The fix is to index what the code actually means by live. archived/cleaned
-- rows are excluded by their status, so revival of the same row stays legal and
-- the round-2 guarantee is unchanged for every row that was already coherent.
--
-- 20260824222751 is already applied where this repo runs, so this is a forward
-- migration that replaces the predicate rather than an edit to that file.

-- 1. Repair rows the previous migration's dedupe could have left incoherent:
--    archived timestamp set, runtime status still live. Scope matches that
--    dedupe's own WHERE clause exactly — unrelated rows are not touched.
UPDATE studios
SET status = 'archived'
WHERE ephemeral = true
  AND archived_at IS NOT NULL
  AND status IN ('active', 'idle')
  AND parent_studio_id IS NOT NULL
  AND thread_key IS NOT NULL;

-- 2. Re-dedupe under the NEW predicate. The old index could not see duplicates
--    that differed only by status, so environments that pre-date this may still
--    hold some. Newest wins — it is the one current sessions were most recently
--    routed to. Both columns are written together so the row tells one story.
UPDATE studios
SET status = 'archived',
    archived_at = COALESCE(archived_at, now())
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY parent_studio_id, thread_key
             ORDER BY created_at DESC
           ) AS rn
    FROM studios
    WHERE ephemeral = true
      AND status IN ('active', 'idle')
      AND parent_studio_id IS NOT NULL
      AND thread_key IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- 3. Swap the fence.
DROP INDEX IF EXISTS uniq_live_ephemeral_studio_per_parent_thread;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_ephemeral_studio_per_parent_thread
  ON studios (parent_studio_id, thread_key)
  WHERE ephemeral = true
    AND status IN ('active', 'idle')
    AND parent_studio_id IS NOT NULL
    AND thread_key IS NOT NULL;
