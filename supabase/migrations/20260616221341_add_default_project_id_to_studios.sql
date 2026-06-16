-- Add default_project_id to studios
-- When an SB creates a task group from a studio, it inherits this project
-- unless explicitly overridden or set to null.
ALTER TABLE studios
  ADD COLUMN default_project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX idx_studios_default_project_id
  ON studios (default_project_id)
  WHERE default_project_id IS NOT NULL;
