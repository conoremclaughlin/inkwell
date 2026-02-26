-- Add role_template column to studios table.
-- Tracks which role template (reviewer, builder, product, or custom) was used
-- when creating the studio, enabling cloud persistence of the role association.
ALTER TABLE studios ADD COLUMN role_template text;
