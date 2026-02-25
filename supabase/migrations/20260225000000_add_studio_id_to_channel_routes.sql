-- Add studio_hint to channel_routes so routes can pin to a studio by name.
-- "main" routes to the main-branch studio. NULL means auto-resolve (nearest session).
-- Using a text hint instead of a UUID FK avoids requiring a studio record to exist upfront.
ALTER TABLE channel_routes ADD COLUMN studio_hint text;

COMMENT ON COLUMN channel_routes.studio_hint IS 'Optional studio hint (e.g. "main"). When set, messages use this hint for studio resolution.';
