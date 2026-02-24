-- Add slack_id to users table for Slack channel integration
ALTER TABLE users ADD COLUMN slack_id varchar(255);
CREATE UNIQUE INDEX users_slack_id_key ON users (slack_id) WHERE slack_id IS NOT NULL;
