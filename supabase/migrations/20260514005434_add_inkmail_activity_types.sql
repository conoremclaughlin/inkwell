-- Add inkmail delivery tracking activity types
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'inkmail_dispatch';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'inkmail_deliver';
ALTER TYPE activity_type ADD VALUE IF NOT EXISTS 'inkmail_fail';
