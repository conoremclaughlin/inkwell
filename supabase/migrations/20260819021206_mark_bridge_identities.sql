-- Mark relay identities so studio routing can exclude them from caller-repo
-- inference (spec: trigger-studio-routing §Tier 7, Phase 3b).
--
-- A bridge is ambiently "in" its own home repo, never the repo the
-- conversation is about, so inferring from one would confidently route every
-- bridged thread into the bridge's own worktree. The flag lives on the
-- identity rather than in a hardcoded slug list because bridges are a
-- property of the deployment, and slugs are ambiguous across workspaces.
--
-- New bridges set metadata.bridge = true; nothing else reads this yet.
UPDATE agent_identities
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"bridge": true}'::jsonb
WHERE agent_id IN ('myra', 'benson');
