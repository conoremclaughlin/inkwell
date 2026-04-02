-- Add type column to contacts for categorization
--
-- Values:
--   'personal'  — manually added contacts (address book)
--   'external'  — auto-created from incoming channel messages
--   'group'     — synthetic group chat contacts
--
-- Default 'personal' for backward compatibility with existing rows.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS type text DEFAULT 'personal';

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_contacts_user_type ON contacts(user_id, type);
