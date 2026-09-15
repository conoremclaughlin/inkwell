-- One LIVE ephemeral studio per (parent_studio_id, thread_key).
--
-- ensureOverflowStudio preflights slug variants before creating, but the
-- preflight is check-then-act: two concurrent ensures can both observe no
-- row, one wins the primary branch, the other falls through to the hash
-- variant, and both inserts succeed — one thread split across two live
-- studios (PR #537 round 2). The existing (worktree_path, agent_id) unique
-- index cannot arbitrate because the variants' paths differ.
--
-- The concurrency boundary is cross-process (the main server and isolated
-- test servers share this database), so the fence has to live here: the
-- losing insert — or a revive UPDATE bringing a row back into the live
-- predicate — fails with a unique violation, the service removes its
-- worktree and fails that call, and the caller's retry converges on the
-- winner via the reuse preflight.
--
-- Cleaned and archived rows stay out of the index: revival flips cleaned_at
-- back to NULL on the SAME row, so at most one live row ever exists per
-- (parent, thread).

-- Defensive for environments that pre-date the index (the shared DB has no
-- duplicates today): retire all but the newest live duplicate. Newest wins
-- because it is the one current sessions were most recently routed to.
UPDATE studios
SET archived_at = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY parent_studio_id, thread_key
             ORDER BY created_at DESC
           ) AS rn
    FROM studios
    WHERE ephemeral = true
      AND cleaned_at IS NULL
      AND archived_at IS NULL
      AND parent_studio_id IS NOT NULL
      AND thread_key IS NOT NULL
  ) ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_ephemeral_studio_per_parent_thread
  ON studios (parent_studio_id, thread_key)
  WHERE ephemeral = true
    AND cleaned_at IS NULL
    AND archived_at IS NULL
    AND parent_studio_id IS NOT NULL
    AND thread_key IS NOT NULL;
