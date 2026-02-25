-- Add studio_id to channel_routes so routes can pin to a specific studio/worktree.
-- When set, incoming messages on this route will be routed to sessions in the
-- specified studio, preventing random assignment to whichever studio was most recent.
ALTER TABLE channel_routes ADD COLUMN studio_id uuid REFERENCES studios(id) ON DELETE SET NULL;

COMMENT ON COLUMN channel_routes.studio_id IS 'Optional studio to pin this route to. When set, messages use this studio for session creation.';
