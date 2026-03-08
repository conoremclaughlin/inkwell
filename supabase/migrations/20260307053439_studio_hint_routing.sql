-- Studio Hint Routing
--
-- Every SB gets a "home" studio via agent_identities.studio_hint.
-- Reminders can override to a specific studio via scheduled_reminders.studio_hint.
-- Resolution cascade: work-specific → agent home → 'home'.

-- 1. Agent identity home studio (default: 'home')
ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS studio_hint text DEFAULT 'home';

-- Backfill: any identity that already has routes with studio_hint set,
-- inherit the most recently updated one as their default.
UPDATE agent_identities ai
SET studio_hint = sub.latest_hint
FROM (
  SELECT DISTINCT ON (cr.identity_id)
    cr.identity_id,
    cr.studio_hint AS latest_hint
  FROM channel_routes cr
  WHERE cr.studio_hint IS NOT NULL
    AND cr.is_active = true
  ORDER BY cr.identity_id, cr.updated_at DESC
) sub
WHERE ai.id = sub.identity_id
  AND ai.studio_hint = 'home';

-- 2. Reminder studio override (nullable — inherits from agent when null)
ALTER TABLE scheduled_reminders
  ADD COLUMN IF NOT EXISTS studio_hint text;

-- 3. Index for routing lookups
CREATE INDEX IF NOT EXISTS idx_agent_identities_studio_hint
  ON agent_identities (studio_hint)
  WHERE studio_hint IS NOT NULL;
