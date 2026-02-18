-- Squashed baseline migration
-- Source: live Supabase cloud database, 2026-02-12

-- ============================================================================
-- Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;

-- ============================================================================
-- Custom Enum Types
-- ============================================================================

CREATE TYPE activity_type AS ENUM (
  'message_in',
  'message_out',
  'tool_call',
  'tool_result',
  'agent_spawn',
  'agent_complete',
  'state_change',
  'thinking',
  'error'
);

CREATE TYPE trust_level AS ENUM (
  'owner',
  'admin',
  'member'
);

-- ============================================================================
-- Tables (dependency order, no FK constraints — those go in part 2)
-- ============================================================================

-- 1. users — almost everything references this
CREATE TABLE users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  telegram_id bigint,
  whatsapp_id character varying(255),
  discord_id character varying(255),
  email character varying(255),
  username character varying(255),
  first_name character varying(255),
  last_name character varying(255),
  preferences jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  phone_number character varying(20),
  telegram_username character varying(255),
  timezone text DEFAULT 'UTC'::text,
  PRIMARY KEY (id),
  UNIQUE (telegram_id),
  UNIQUE (whatsapp_id),
  UNIQUE (discord_id),
  UNIQUE (email),
  UNIQUE (phone_number),
  UNIQUE (telegram_username)
);

-- 2. pcp_config — no FK dependencies
CREATE TABLE pcp_config (
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (key)
);

-- 3. permission_definitions — no FK dependencies (PK is text, not uuid)
CREATE TABLE permission_definitions (
  id text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL,
  risk_level text NOT NULL DEFAULT 'medium'::text,
  default_enabled boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 4. contacts — referenced by mini_app_records, activity_stream
CREATE TABLE contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  display_name text,
  aliases text[] DEFAULT '{}'::text[],
  email text,
  phone text,
  telegram_id text,
  telegram_username text,
  imessage_id text,
  discord_id text,
  whatsapp_id text,
  notes text,
  tags text[] DEFAULT '{}'::text[],
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, name)
);

-- 5. conversations — referenced by messages
CREATE TABLE conversations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  platform character varying(50) NOT NULL,
  platform_conversation_id character varying(255) NOT NULL,
  title text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (platform, platform_conversation_id)
);

-- 6. projects — referenced by project_tasks, session_focus
CREATE TABLE projects (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  description text,
  status character varying(50) DEFAULT 'active'::character varying,
  tech_stack text[],
  repository_url text,
  goals text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, name)
);

-- 7. memories — referenced by session_logs.compacted_into_memory_id
CREATE TABLE memories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  content text NOT NULL,
  source text NOT NULL DEFAULT 'observation'::text,
  salience text NOT NULL DEFAULT 'medium'::text,
  topics text[] DEFAULT '{}'::text[],
  embedding vector(1024),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  version integer NOT NULL DEFAULT 1,
  agent_id text,
  PRIMARY KEY (id)
);

-- 8. artifacts — referenced by artifact_history
CREATE TABLE artifacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  uri text NOT NULL,
  user_id uuid NOT NULL,
  created_by_agent_id text,
  title text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text/markdown'::text,
  artifact_type text NOT NULL DEFAULT 'document'::text,
  collaborators text[] DEFAULT '{}'::text[],
  visibility text DEFAULT 'private'::text,
  version integer DEFAULT 1,
  tags text[] DEFAULT '{}'::text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (uri)
);

-- 9. skills — referenced by skill_versions, skill_installations; self-ref forked_from_id
CREATE TABLE skills (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL,
  type text NOT NULL,
  category text,
  tags text[] DEFAULT '{}'::text[],
  emoji text,
  current_version text NOT NULL DEFAULT '1.0.0'::text,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  content text NOT NULL DEFAULT ''::text,
  author text,
  author_user_id uuid,
  repository_url text,
  homepage_url text,
  is_official boolean DEFAULT false,
  is_public boolean DEFAULT true,
  is_verified boolean DEFAULT false,
  install_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  published_at timestamp with time zone,
  forked_from_id uuid,
  status text DEFAULT 'active'::text,
  deprecated_at timestamp with time zone,
  deprecated_by uuid,
  deprecation_message text,
  last_published_by uuid,
  PRIMARY KEY (id),
  UNIQUE (name)
);

-- 10. scheduled_reminders — referenced by reminder_history
CREATE TABLE scheduled_reminders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  cron_expression text,
  next_run_at timestamp with time zone NOT NULL,
  last_run_at timestamp with time zone,
  delivery_channel text NOT NULL DEFAULT 'telegram'::text,
  delivery_target text,
  status text NOT NULL DEFAULT 'active'::text,
  run_count integer DEFAULT 0,
  max_runs integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 11. sessions — circular ref with workspaces; created WITHOUT workspace_id FK
--     (the FK sessions.workspace_id -> workspaces(id) will be added in part 2)
CREATE TABLE sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id text,
  started_at timestamp with time zone DEFAULT now(),
  ended_at timestamp with time zone,
  summary text,
  metadata jsonb DEFAULT '{}'::jsonb,
  claude_session_id text,
  status text DEFAULT 'active'::text,
  working_dir text,
  context text,
  compacting_since timestamp with time zone,
  message_count integer DEFAULT 0,
  token_count integer DEFAULT 0,
  backend text DEFAULT 'claude-code'::text,
  model text,
  workspace_id uuid,
  current_phase text,
  backend_session_id text,
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 12. workspaces — references sessions(id) via session_id (FK in part 2)
CREATE TABLE workspaces (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id text,
  session_id uuid,
  repo_root text NOT NULL,
  worktree_path text NOT NULL,
  branch text NOT NULL,
  base_branch text DEFAULT 'main'::text,
  purpose text,
  work_type text,
  status text NOT NULL DEFAULT 'active'::text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  archived_at timestamp with time zone,
  cleaned_at timestamp with time zone,
  PRIMARY KEY (id),
  UNIQUE (branch),
  UNIQUE (worktree_path)
);

-- 13. activity_stream — references users, sessions, contacts, self-ref parent_id
CREATE TABLE activity_stream (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid,
  agent_id text NOT NULL,
  type activity_type NOT NULL,
  subtype text,
  content text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_id uuid,
  parent_id uuid,
  correlation_id uuid,
  platform text,
  platform_message_id text,
  platform_chat_id text,
  is_dm boolean DEFAULT true,
  artifact_id uuid,
  child_session_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  duration_ms integer,
  status text DEFAULT 'completed'::text,
  PRIMARY KEY (id),
  UNIQUE (platform, platform_message_id)
);

-- 14. agent_identities
CREATE TABLE agent_identities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  description text,
  "values" jsonb DEFAULT '[]'::jsonb,
  relationships jsonb DEFAULT '{}'::jsonb,
  capabilities jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  version integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  heartbeat text,
  soul text,
  backend text,
  PRIMARY KEY (id),
  UNIQUE (user_id, agent_id)
);

-- 15. agent_identity_history
CREATE TABLE agent_identity_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  description text,
  "values" jsonb DEFAULT '[]'::jsonb,
  relationships jsonb DEFAULT '{}'::jsonb,
  capabilities jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  archived_at timestamp with time zone DEFAULT now(),
  change_type text NOT NULL DEFAULT 'update'::text,
  heartbeat text,
  soul text,
  backend text,
  PRIMARY KEY (id)
);

-- 16. agent_inbox
CREATE TABLE agent_inbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL,
  recipient_agent_id text NOT NULL,
  sender_user_id uuid,
  sender_agent_id text,
  subject text,
  content text NOT NULL,
  message_type text NOT NULL DEFAULT 'message'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  recipient_session_id uuid,
  related_artifact_uri text,
  status text NOT NULL DEFAULT 'unread'::text,
  read_at timestamp with time zone,
  acknowledged_at timestamp with time zone,
  metadata jsonb DEFAULT '{}'::jsonb,
  expires_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 17. agent_sessions
CREATE TABLE agent_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  session_id character varying(255) NOT NULL,
  session_key character varying(255),
  platform character varying(50),
  platform_chat_id character varying(255),
  backend character varying(50) NOT NULL DEFAULT 'claude-code'::character varying,
  model character varying(100),
  status character varying(50) NOT NULL DEFAULT 'active'::character varying,
  working_directory text,
  mcp_config_path text,
  message_count integer DEFAULT 0,
  total_cost numeric(10,4) DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_activity_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  PRIMARY KEY (id),
  UNIQUE (session_id, backend)
);

-- 18. artifact_history
CREATE TABLE artifact_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL,
  version integer NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  changed_by_agent_id text,
  changed_by_user_id uuid,
  change_type text DEFAULT 'update'::text,
  change_summary text,
  created_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 19. audit_log
CREATE TABLE audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  "timestamp" timestamp with time zone NOT NULL DEFAULT now(),
  user_id uuid,
  platform text,
  platform_user_id text,
  conversation_id text,
  action text NOT NULL,
  category text NOT NULL,
  target text,
  request_summary text,
  response_status text,
  response_summary text,
  backend text,
  session_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  PRIMARY KEY (id)
);

-- 20. authorized_groups
CREATE TABLE authorized_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  platform_group_id text NOT NULL,
  group_name text,
  authorized_by uuid,
  authorized_at timestamp with time zone DEFAULT now(),
  authorization_method text,
  status text NOT NULL DEFAULT 'active'::text,
  revoked_at timestamp with time zone,
  revoked_by uuid,
  PRIMARY KEY (id),
  UNIQUE (platform, platform_group_id)
);

-- 21. connected_accounts
CREATE TABLE connected_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider character varying(50) NOT NULL,
  provider_account_id character varying(255) NOT NULL,
  email character varying(255),
  display_name character varying(255),
  avatar_url text,
  access_token text NOT NULL,
  refresh_token text,
  token_type character varying(50) DEFAULT 'Bearer'::character varying,
  expires_at timestamp with time zone,
  refresh_token_expires_at timestamp with time zone,
  scopes text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  status character varying(50) DEFAULT 'active'::character varying,
  last_error text,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, provider, provider_account_id)
);

-- 22. context_history
CREATE TABLE context_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL,
  user_id uuid NOT NULL,
  context_type text NOT NULL,
  context_key text,
  summary text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  archived_at timestamp with time zone DEFAULT now(),
  change_type text NOT NULL DEFAULT 'update'::text,
  PRIMARY KEY (id)
);

-- 23. context_summaries
CREATE TABLE context_summaries (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  context_type character varying(50) NOT NULL,
  context_key character varying(255),
  summary text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  version integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, context_type, context_key)
);

-- 24. group_challenge_codes
CREATE TABLE group_challenge_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
  used_for_platform text,
  used_for_group_id text,
  used_at timestamp with time zone,
  PRIMARY KEY (id),
  UNIQUE (code)
);

-- 25. heartbeat_state — PK is user_id, not id
CREATE TABLE heartbeat_state (
  user_id uuid NOT NULL,
  last_checks jsonb DEFAULT '{}'::jsonb,
  quiet_start time without time zone,
  quiet_end time without time zone,
  timezone text DEFAULT 'UTC'::text,
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (user_id)
);

-- 26. links
CREATE TABLE links (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  url text NOT NULL,
  title text,
  description text,
  tags text[] DEFAULT '{}'::text[],
  source character varying(50),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  embedding vector(1024),
  PRIMARY KEY (id)
);

-- 27. mcp_tokens
CREATE TABLE mcp_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id text NOT NULL,
  refresh_token text NOT NULL,
  supabase_refresh_token text,
  scopes text[] DEFAULT ARRAY['mcp:tools'::text],
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_used_at timestamp with time zone,
  PRIMARY KEY (id),
  UNIQUE (refresh_token)
);

-- 28. memory_history
CREATE TABLE memory_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL,
  source text NOT NULL,
  salience text NOT NULL,
  topics text[] DEFAULT '{}'::text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL,
  archived_at timestamp with time zone DEFAULT now(),
  change_type text NOT NULL DEFAULT 'update'::text,
  PRIMARY KEY (id)
);

-- 29. messages — references conversations
CREATE TABLE messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL,
  message_type character varying(50) DEFAULT 'text'::character varying,
  platform_message_id character varying(255),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  embedding vector(1024),
  PRIMARY KEY (id)
);

-- 30. mini_app_records — references contacts, self-ref related_record_id
CREATE TABLE mini_app_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  app_name text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount numeric(12,2),
  recorded_at date,
  text text,
  tags text[],
  related_record_id uuid,
  related_entity_type text,
  related_entity_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  contact_id uuid,
  PRIMARY KEY (id)
);

-- 31. notes
CREATE TABLE notes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text,
  content text NOT NULL,
  tags text[] DEFAULT '{}'::text[],
  is_private boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  embedding vector(1024),
  PRIMARY KEY (id)
);

-- 32. project_tasks — references projects
CREATE TABLE project_tasks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title character varying(500) NOT NULL,
  description text,
  status character varying(50) NOT NULL DEFAULT 'pending'::character varying,
  priority character varying(20) DEFAULT 'medium'::character varying,
  tags text[] DEFAULT '{}'::text[],
  blocked_by uuid[],
  created_by character varying(100),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 33. reminder_history — references scheduled_reminders
CREATE TABLE reminder_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL,
  triggered_at timestamp with time zone DEFAULT now(),
  delivered_at timestamp with time zone,
  status text NOT NULL,
  error_message text,
  response_received boolean DEFAULT false,
  response_at timestamp with time zone,
  response_content text,
  PRIMARY KEY (id)
);

-- 34. reminders
CREATE TABLE reminders (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  message text NOT NULL,
  reminder_time timestamp with time zone NOT NULL,
  status character varying(50) DEFAULT 'pending'::character varying,
  recurrence jsonb,
  channel character varying(50) NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 35. session_focus — references sessions (via session_id text), projects
CREATE TABLE session_focus (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  session_id character varying(255),
  project_id uuid,
  focus_summary text,
  context_snapshot jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (user_id, session_id)
);

-- 36. session_logs — references sessions, memories
CREATE TABLE session_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  content text NOT NULL,
  salience text NOT NULL DEFAULT 'medium'::text,
  created_at timestamp with time zone DEFAULT now(),
  compacted_at timestamp with time zone,
  compacted_into_memory_id uuid,
  PRIMARY KEY (id)
);

-- 37. skill_installations — references skills
CREATE TABLE skill_installations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  version_pinned text,
  enabled boolean DEFAULT true,
  config jsonb DEFAULT '{}'::jsonb,
  installed_at timestamp with time zone DEFAULT now(),
  last_used_at timestamp with time zone,
  usage_count integer DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (user_id, skill_id)
);

-- 38. skill_versions — references skills
CREATE TABLE skill_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL,
  version text NOT NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  content text NOT NULL DEFAULT ''::text,
  changelog text,
  published_by uuid,
  published_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (skill_id, version)
);

-- 39. tasks
CREATE TABLE tasks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status character varying(50) DEFAULT 'pending'::character varying,
  priority character varying(50) DEFAULT 'medium'::character varying,
  due_date timestamp with time zone,
  completed_at timestamp with time zone,
  tags text[] DEFAULT '{}'::text[],
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id)
);

-- 40. trusted_users
CREATE TABLE trusted_users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  platform text NOT NULL,
  platform_user_id text NOT NULL,
  trust_level trust_level NOT NULL DEFAULT 'member'::trust_level,
  added_by uuid,
  added_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (platform, platform_user_id)
);

-- 41. user_identity
CREATE TABLE user_identity (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  user_profile_md text,
  shared_values_md text,
  version integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  process_md text,
  PRIMARY KEY (id),
  UNIQUE (user_id)
);

-- 42. user_identity_history
CREATE TABLE user_identity_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL,
  user_id uuid NOT NULL,
  user_profile_md text,
  shared_values_md text,
  version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  archived_at timestamp with time zone DEFAULT now(),
  change_type text NOT NULL DEFAULT 'update'::text,
  process_md text,
  PRIMARY KEY (id)
);

-- 43. user_permissions — references permission_definitions
CREATE TABLE user_permissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  permission_id text NOT NULL,
  enabled boolean NOT NULL,
  granted_by uuid,
  granted_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  reason text,
  PRIMARY KEY (id),
  UNIQUE (user_id, permission_id)
);
-- ============================================================================
-- Foreign keys, check constraints, and indexes
-- Part 2 of squashed migration
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Deferred FKs for circular references (sessions <-> workspaces)
-- ----------------------------------------------------------------------------

ALTER TABLE sessions ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- 2. All other foreign key constraints
-- ----------------------------------------------------------------------------

-- activity_stream
ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES activity_stream(id) ON DELETE SET NULL;
ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_identities
ALTER TABLE agent_identities ADD CONSTRAINT agent_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_identity_history
ALTER TABLE agent_identity_history ADD CONSTRAINT agent_identity_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- agent_inbox
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_recipient_session_id_fkey FOREIGN KEY (recipient_session_id) REFERENCES sessions(id) ON DELETE NO ACTION;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- agent_sessions
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- artifact_history
ALTER TABLE artifact_history ADD CONSTRAINT artifact_history_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE;
ALTER TABLE artifact_history ADD CONSTRAINT artifact_history_changed_by_user_id_fkey FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- artifacts
ALTER TABLE artifacts ADD CONSTRAINT artifacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- audit_log
ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- authorized_groups
ALTER TABLE authorized_groups ADD CONSTRAINT authorized_groups_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE authorized_groups ADD CONSTRAINT authorized_groups_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE NO ACTION;

-- connected_accounts
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- contacts
ALTER TABLE contacts ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- context_history
ALTER TABLE context_history ADD CONSTRAINT context_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- context_summaries
ALTER TABLE context_summaries ADD CONSTRAINT context_summaries_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- conversations
ALTER TABLE conversations ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- group_challenge_codes
ALTER TABLE group_challenge_codes ADD CONSTRAINT group_challenge_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE NO ACTION;

-- heartbeat_state
ALTER TABLE heartbeat_state ADD CONSTRAINT heartbeat_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- links
ALTER TABLE links ADD CONSTRAINT links_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- mcp_tokens
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- memories
ALTER TABLE memories ADD CONSTRAINT memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- memory_history
ALTER TABLE memory_history ADD CONSTRAINT memory_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- messages
ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- mini_app_records
ALTER TABLE mini_app_records ADD CONSTRAINT mini_app_records_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE mini_app_records ADD CONSTRAINT mini_app_records_related_record_id_fkey FOREIGN KEY (related_record_id) REFERENCES mini_app_records(id) ON DELETE SET NULL;
ALTER TABLE mini_app_records ADD CONSTRAINT mini_app_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- notes
ALTER TABLE notes ADD CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- project_tasks
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- projects
ALTER TABLE projects ADD CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- reminder_history
ALTER TABLE reminder_history ADD CONSTRAINT reminder_history_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES scheduled_reminders(id) ON DELETE CASCADE;

-- reminders
ALTER TABLE reminders ADD CONSTRAINT reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- scheduled_reminders
ALTER TABLE scheduled_reminders ADD CONSTRAINT scheduled_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- session_focus
ALTER TABLE session_focus ADD CONSTRAINT session_focus_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE session_focus ADD CONSTRAINT session_focus_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- session_logs
ALTER TABLE session_logs ADD CONSTRAINT session_logs_compacted_into_memory_id_fkey FOREIGN KEY (compacted_into_memory_id) REFERENCES memories(id) ON DELETE NO ACTION;
ALTER TABLE session_logs ADD CONSTRAINT session_logs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

-- sessions (user_id FK only; workspace_id handled above as deferred)
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- skill_installations
ALTER TABLE skill_installations ADD CONSTRAINT skill_installations_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;
ALTER TABLE skill_installations ADD CONSTRAINT skill_installations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- skill_versions
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;

-- skills
ALTER TABLE skills ADD CONSTRAINT skills_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE skills ADD CONSTRAINT skills_deprecated_by_fkey FOREIGN KEY (deprecated_by) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE skills ADD CONSTRAINT skills_forked_from_id_fkey FOREIGN KEY (forked_from_id) REFERENCES skills(id) ON DELETE SET NULL;
ALTER TABLE skills ADD CONSTRAINT skills_last_published_by_fkey FOREIGN KEY (last_published_by) REFERENCES users(id) ON DELETE NO ACTION;

-- tasks
ALTER TABLE tasks ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- trusted_users
ALTER TABLE trusted_users ADD CONSTRAINT trusted_users_added_by_fkey FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE trusted_users ADD CONSTRAINT trusted_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- user_identity
ALTER TABLE user_identity ADD CONSTRAINT user_identity_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- user_identity_history
ALTER TABLE user_identity_history ADD CONSTRAINT user_identity_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- user_permissions
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE NO ACTION;
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES permission_definitions(id) ON DELETE NO ACTION;
ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- workspaces (user_id FK only; session_id handled above as deferred)
ALTER TABLE workspaces ADD CONSTRAINT workspaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. Check constraints
-- ----------------------------------------------------------------------------

ALTER TABLE activity_stream ADD CONSTRAINT activity_stream_status_check CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text]));
ALTER TABLE agent_identity_history ADD CONSTRAINT agent_identity_history_change_type_check CHECK (change_type = ANY (ARRAY['update'::text, 'delete'::text]));
ALTER TABLE agent_inbox ADD CONSTRAINT valid_message_type CHECK (message_type = ANY (ARRAY['message'::text, 'task_request'::text, 'session_resume'::text, 'notification'::text]));
ALTER TABLE agent_inbox ADD CONSTRAINT valid_priority CHECK (priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]));
ALTER TABLE agent_inbox ADD CONSTRAINT valid_status CHECK (status = ANY (ARRAY['unread'::text, 'read'::text, 'acknowledged'::text, 'completed'::text]));
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_status_check CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'revoked'::character varying, 'error'::character varying])::text[]));
ALTER TABLE context_history ADD CONSTRAINT valid_ctx_change_type CHECK (change_type = ANY (ARRAY['update'::text, 'delete'::text]));
ALTER TABLE context_summaries ADD CONSTRAINT context_summaries_context_type_check CHECK ((context_type)::text = ANY ((ARRAY['user'::character varying, 'assistant'::character varying, 'project'::character varying, 'session'::character varying, 'relationship'::character varying])::text[]));
ALTER TABLE conversations ADD CONSTRAINT conversations_platform_check CHECK ((platform)::text = ANY ((ARRAY['telegram'::character varying, 'whatsapp'::character varying, 'discord'::character varying, 'api'::character varying])::text[]));
ALTER TABLE memories ADD CONSTRAINT valid_source CHECK (source = ANY (ARRAY['conversation'::text, 'observation'::text, 'user_stated'::text, 'inferred'::text, 'session'::text]));
ALTER TABLE memories ADD CONSTRAINT valid_salience CHECK (salience = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]));
ALTER TABLE memory_history ADD CONSTRAINT valid_change_type CHECK (change_type = ANY (ARRAY['update'::text, 'delete'::text]));
ALTER TABLE messages ADD CONSTRAINT messages_message_type_check CHECK ((message_type)::text = ANY ((ARRAY['text'::character varying, 'link'::character varying, 'command'::character varying, 'system'::character varying])::text[]));
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'completed'::character varying, 'archived'::character varying])::text[]));
ALTER TABLE reminder_history ADD CONSTRAINT reminder_history_status_check CHECK (status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'skipped'::text]));
ALTER TABLE reminders ADD CONSTRAINT reminders_status_check CHECK ((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'cancelled'::character varying])::text[]));
ALTER TABLE reminders ADD CONSTRAINT reminders_channel_check CHECK ((channel)::text = ANY ((ARRAY['telegram'::character varying, 'whatsapp'::character varying, 'discord'::character varying])::text[]));
ALTER TABLE scheduled_reminders ADD CONSTRAINT scheduled_reminders_status_check CHECK (status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text, 'failed'::text]));
ALTER TABLE session_logs ADD CONSTRAINT valid_log_salience CHECK (salience = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]));
ALTER TABLE skills ADD CONSTRAINT skills_type_check CHECK (type = ANY (ARRAY['mini-app'::text, 'cli'::text, 'guide'::text]));
ALTER TABLE skills ADD CONSTRAINT skills_status_check CHECK (status = ANY (ARRAY['active'::text, 'deprecated'::text, 'deleted'::text]));
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK ((status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[]));
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check CHECK ((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]));
ALTER TABLE user_identity_history ADD CONSTRAINT user_identity_history_change_type_check CHECK (change_type = ANY (ARRAY['update'::text, 'delete'::text]));
ALTER TABLE workspaces ADD CONSTRAINT workspaces_work_type_check CHECK (work_type = ANY (ARRAY['feature'::text, 'bugfix'::text, 'refactor'::text, 'chore'::text, 'experiment'::text, 'other'::text]));
ALTER TABLE workspaces ADD CONSTRAINT workspaces_status_check CHECK (status = ANY (ARRAY['active'::text, 'idle'::text, 'archived'::text, 'cleaned'::text]));

-- ----------------------------------------------------------------------------
-- 4. Indexes (non-pkey)
-- All unique indexes use IF NOT EXISTS since UNIQUE constraints in CREATE TABLE
-- may have already created the underlying index.
-- ----------------------------------------------------------------------------

-- activity_stream
CREATE UNIQUE INDEX IF NOT EXISTS activity_stream_platform_platform_message_id_key ON public.activity_stream USING btree (platform, platform_message_id);
CREATE INDEX idx_activity_contact_messages ON public.activity_stream USING btree (user_id, contact_id, created_at DESC) WHERE (type = ANY (ARRAY['message_in'::activity_type, 'message_out'::activity_type]));
CREATE INDEX idx_activity_correlation ON public.activity_stream USING btree (correlation_id, created_at) WHERE (correlation_id IS NOT NULL);
CREATE INDEX idx_activity_parent ON public.activity_stream USING btree (parent_id, created_at) WHERE (parent_id IS NOT NULL);
CREATE INDEX idx_activity_pending ON public.activity_stream USING btree (status, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));
CREATE INDEX idx_activity_platform_chat ON public.activity_stream USING btree (user_id, platform, platform_chat_id, created_at DESC);
CREATE INDEX idx_activity_session_time ON public.activity_stream USING btree (session_id, created_at DESC);
CREATE INDEX idx_activity_tools ON public.activity_stream USING btree (agent_id, subtype, created_at DESC) WHERE (type = 'tool_call'::activity_type);
CREATE INDEX idx_activity_user_messages ON public.activity_stream USING btree (user_id, created_at DESC) WHERE (type = ANY (ARRAY['message_in'::activity_type, 'message_out'::activity_type]));
CREATE INDEX idx_activity_user_time ON public.activity_stream USING btree (user_id, created_at DESC);

-- agent_identities
CREATE UNIQUE INDEX IF NOT EXISTS agent_identities_user_id_agent_id_key ON public.agent_identities USING btree (user_id, agent_id);
CREATE INDEX idx_agent_identities_user_agent ON public.agent_identities USING btree (user_id, agent_id);
CREATE INDEX idx_agent_identities_user_id ON public.agent_identities USING btree (user_id);

-- agent_identity_history
CREATE INDEX idx_agent_identity_history_archived_at ON public.agent_identity_history USING btree (archived_at DESC);
CREATE INDEX idx_agent_identity_history_identity_id ON public.agent_identity_history USING btree (identity_id);
CREATE INDEX idx_agent_identity_history_user_id ON public.agent_identity_history USING btree (user_id);

-- agent_inbox
CREATE INDEX idx_agent_inbox_priority ON public.agent_inbox USING btree (recipient_user_id, recipient_agent_id, priority, created_at) WHERE (status = 'unread'::text);
CREATE INDEX idx_agent_inbox_recipient ON public.agent_inbox USING btree (recipient_user_id, recipient_agent_id, status);
CREATE INDEX idx_agent_inbox_sender ON public.agent_inbox USING btree (sender_user_id, sender_agent_id);
CREATE INDEX idx_agent_inbox_recipient_session ON public.agent_inbox USING btree (recipient_session_id) WHERE (recipient_session_id IS NOT NULL);

-- agent_sessions
CREATE INDEX idx_agent_sessions_last_activity ON public.agent_sessions USING btree (last_activity_at);
CREATE INDEX idx_agent_sessions_platform ON public.agent_sessions USING btree (platform, platform_chat_id);
CREATE INDEX idx_agent_sessions_session_id ON public.agent_sessions USING btree (session_id);
CREATE INDEX idx_agent_sessions_session_key ON public.agent_sessions USING btree (session_key);
CREATE INDEX idx_agent_sessions_status ON public.agent_sessions USING btree (status);
CREATE INDEX idx_agent_sessions_user ON public.agent_sessions USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_session_per_backend ON public.agent_sessions USING btree (session_id, backend);

-- artifact_history
CREATE INDEX idx_artifact_history_artifact_id ON public.artifact_history USING btree (artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_history_artifact_version ON public.artifact_history USING btree (artifact_id, version);

-- artifacts
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_uri_key ON public.artifacts USING btree (uri);
CREATE INDEX idx_artifacts_tags ON public.artifacts USING gin (tags);
CREATE INDEX idx_artifacts_type ON public.artifacts USING btree (artifact_type);
CREATE INDEX idx_artifacts_uri ON public.artifacts USING btree (uri);
CREATE INDEX idx_artifacts_user_id ON public.artifacts USING btree (user_id);

-- audit_log
CREATE INDEX idx_audit_log_action ON public.audit_log USING btree (action, "timestamp" DESC);
CREATE INDEX idx_audit_log_timestamp ON public.audit_log USING btree ("timestamp" DESC);
CREATE INDEX idx_audit_log_user_time ON public.audit_log USING btree (user_id, "timestamp" DESC);

-- authorized_groups
CREATE UNIQUE INDEX IF NOT EXISTS authorized_groups_platform_platform_group_id_key ON public.authorized_groups USING btree (platform, platform_group_id);
CREATE INDEX idx_authorized_groups_platform_lookup ON public.authorized_groups USING btree (platform, platform_group_id) WHERE (status = 'active'::text);

-- connected_accounts
CREATE INDEX idx_connected_accounts_expires_at ON public.connected_accounts USING btree (expires_at);
CREATE INDEX idx_connected_accounts_provider ON public.connected_accounts USING btree (provider);
CREATE INDEX idx_connected_accounts_status ON public.connected_accounts USING btree (status);
CREATE INDEX idx_connected_accounts_user_id ON public.connected_accounts USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS unique_user_provider_account ON public.connected_accounts USING btree (user_id, provider, provider_account_id);

-- contacts
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_id_name_key ON public.contacts USING btree (user_id, name);
CREATE INDEX idx_contacts_aliases ON public.contacts USING gin (aliases);
CREATE INDEX idx_contacts_email ON public.contacts USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX idx_contacts_phone ON public.contacts USING btree (phone) WHERE (phone IS NOT NULL);
CREATE INDEX idx_contacts_telegram_id ON public.contacts USING btree (telegram_id) WHERE (telegram_id IS NOT NULL);
CREATE INDEX idx_contacts_user_id ON public.contacts USING btree (user_id);

-- context_history
CREATE INDEX idx_context_history_archived_at ON public.context_history USING btree (archived_at DESC);
CREATE INDEX idx_context_history_context_id ON public.context_history USING btree (context_id);
CREATE INDEX idx_context_history_user_id ON public.context_history USING btree (user_id);

-- context_summaries
CREATE UNIQUE INDEX IF NOT EXISTS context_summaries_user_id_context_type_context_key_key ON public.context_summaries USING btree (user_id, context_type, context_key);
CREATE INDEX idx_context_summaries_key ON public.context_summaries USING btree (context_key);
CREATE INDEX idx_context_summaries_user_type ON public.context_summaries USING btree (user_id, context_type);

-- conversations
CREATE UNIQUE INDEX IF NOT EXISTS conversations_platform_platform_conversation_id_key ON public.conversations USING btree (platform, platform_conversation_id);
CREATE INDEX idx_conversations_created_at ON public.conversations USING btree (created_at DESC);
CREATE INDEX idx_conversations_platform ON public.conversations USING btree (platform, platform_conversation_id);
CREATE INDEX idx_conversations_user_id ON public.conversations USING btree (user_id);

-- group_challenge_codes
CREATE UNIQUE INDEX IF NOT EXISTS group_challenge_codes_code_key ON public.group_challenge_codes USING btree (code);
CREATE INDEX idx_challenge_codes_unused ON public.group_challenge_codes USING btree (code) WHERE (used_at IS NULL);

-- links
CREATE INDEX idx_links_created_at ON public.links USING btree (created_at DESC);
CREATE INDEX idx_links_description_trgm ON public.links USING gin (description gin_trgm_ops);
CREATE INDEX idx_links_embedding ON public.links USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_links_tags ON public.links USING gin (tags);
CREATE INDEX idx_links_title_trgm ON public.links USING gin (title gin_trgm_ops);
CREATE INDEX idx_links_url ON public.links USING btree (url);
CREATE INDEX idx_links_user_id ON public.links USING btree (user_id);

-- mcp_tokens
CREATE INDEX idx_mcp_tokens_expires_at ON public.mcp_tokens USING btree (expires_at);
CREATE INDEX idx_mcp_tokens_refresh_token ON public.mcp_tokens USING btree (refresh_token);
CREATE INDEX idx_mcp_tokens_user_id ON public.mcp_tokens USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_tokens_refresh_token_key ON public.mcp_tokens USING btree (refresh_token);

-- memories
CREATE INDEX idx_memories_agent_id ON public.memories USING btree (agent_id);
CREATE INDEX idx_memories_created_at ON public.memories USING btree (created_at DESC);
CREATE INDEX idx_memories_salience ON public.memories USING btree (salience);
CREATE INDEX idx_memories_source ON public.memories USING btree (source);
CREATE INDEX idx_memories_topics ON public.memories USING gin (topics);
CREATE INDEX idx_memories_user_agent ON public.memories USING btree (user_id, agent_id);
CREATE INDEX idx_memories_user_id ON public.memories USING btree (user_id);

-- memory_history
CREATE INDEX idx_memory_history_archived_at ON public.memory_history USING btree (archived_at DESC);
CREATE INDEX idx_memory_history_memory_id ON public.memory_history USING btree (memory_id);
CREATE INDEX idx_memory_history_user_id ON public.memory_history USING btree (user_id);

-- messages
CREATE INDEX idx_messages_content_fts ON public.messages USING gin (to_tsvector('english'::regconfig, content));
CREATE INDEX idx_messages_conversation_id ON public.messages USING btree (conversation_id);
CREATE INDEX idx_messages_created_at ON public.messages USING btree (created_at DESC);
CREATE INDEX idx_messages_embedding ON public.messages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_messages_user_id ON public.messages USING btree (user_id);

-- mini_app_records
CREATE INDEX idx_mini_app_records_amount ON public.mini_app_records USING btree (user_id, amount) WHERE (amount IS NOT NULL);
CREATE INDEX idx_mini_app_records_contact ON public.mini_app_records USING btree (contact_id) WHERE (contact_id IS NOT NULL);
CREATE INDEX idx_mini_app_records_created ON public.mini_app_records USING btree (user_id, created_at DESC);
CREATE INDEX idx_mini_app_records_data ON public.mini_app_records USING gin (data);
CREATE INDEX idx_mini_app_records_recorded_at ON public.mini_app_records USING btree (user_id, recorded_at) WHERE (recorded_at IS NOT NULL);
CREATE INDEX idx_mini_app_records_tags ON public.mini_app_records USING gin (tags) WHERE (tags IS NOT NULL);
CREATE INDEX idx_mini_app_records_text ON public.mini_app_records USING gin (to_tsvector('english'::regconfig, text)) WHERE (text IS NOT NULL);
CREATE INDEX idx_mini_app_records_user_app ON public.mini_app_records USING btree (user_id, app_name);
CREATE INDEX idx_mini_app_records_user_type ON public.mini_app_records USING btree (user_id, app_name, type);

-- notes
CREATE INDEX idx_notes_content_fts ON public.notes USING gin (to_tsvector('english'::regconfig, content));
CREATE INDEX idx_notes_created_at ON public.notes USING btree (created_at DESC);
CREATE INDEX idx_notes_embedding ON public.notes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_notes_tags ON public.notes USING gin (tags);
CREATE INDEX idx_notes_title_trgm ON public.notes USING gin (title gin_trgm_ops);
CREATE INDEX idx_notes_user_id ON public.notes USING btree (user_id);

-- project_tasks
CREATE INDEX idx_project_tasks_created ON public.project_tasks USING btree (created_at);
CREATE INDEX idx_project_tasks_priority ON public.project_tasks USING btree (priority);
CREATE INDEX idx_project_tasks_project ON public.project_tasks USING btree (project_id);
CREATE INDEX idx_project_tasks_status ON public.project_tasks USING btree (status);
CREATE INDEX idx_project_tasks_user ON public.project_tasks USING btree (user_id);

-- projects
CREATE INDEX idx_projects_status ON public.projects USING btree (status);
CREATE INDEX idx_projects_user_id ON public.projects USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_user_id_name_key ON public.projects USING btree (user_id, name);

-- reminder_history
CREATE INDEX idx_reminder_history_reminder_id ON public.reminder_history USING btree (reminder_id);
CREATE INDEX idx_reminder_history_triggered_at ON public.reminder_history USING btree (triggered_at DESC);

-- reminders
CREATE INDEX idx_reminders_channel ON public.reminders USING btree (channel);
CREATE INDEX idx_reminders_reminder_time ON public.reminders USING btree (reminder_time);
CREATE INDEX idx_reminders_status ON public.reminders USING btree (status);
CREATE INDEX idx_reminders_user_id ON public.reminders USING btree (user_id);

-- scheduled_reminders
CREATE INDEX idx_scheduled_reminders_next_run ON public.scheduled_reminders USING btree (next_run_at) WHERE (status = 'active'::text);
CREATE INDEX idx_scheduled_reminders_user_id ON public.scheduled_reminders USING btree (user_id);

-- session_focus
CREATE INDEX idx_session_focus_session ON public.session_focus USING btree (session_id);
CREATE INDEX idx_session_focus_user ON public.session_focus USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS session_focus_user_id_session_id_key ON public.session_focus USING btree (user_id, session_id);

-- session_logs
CREATE INDEX idx_session_logs_compacted_at ON public.session_logs USING btree (compacted_at) WHERE (compacted_at IS NULL);
CREATE INDEX idx_session_logs_created_at ON public.session_logs USING btree (created_at DESC);
CREATE INDEX idx_session_logs_session_id ON public.session_logs USING btree (session_id);

-- sessions
CREATE INDEX idx_sessions_active_lookup ON public.sessions USING btree (user_id, agent_id, workspace_id) WHERE (ended_at IS NULL);
CREATE INDEX idx_sessions_agent_id ON public.sessions USING btree (agent_id);
CREATE INDEX idx_sessions_agent_status ON public.sessions USING btree (agent_id, status);
CREATE INDEX idx_sessions_backend_session_id ON public.sessions USING btree (backend_session_id) WHERE (backend_session_id IS NOT NULL);
CREATE INDEX idx_sessions_current_phase ON public.sessions USING btree (current_phase) WHERE (ended_at IS NULL);
CREATE INDEX idx_sessions_started_at ON public.sessions USING btree (started_at DESC);
CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);
CREATE INDEX idx_sessions_workspace_id ON public.sessions USING btree (workspace_id);

-- skill_installations
CREATE INDEX idx_skill_installations_enabled ON public.skill_installations USING btree (user_id, enabled) WHERE (enabled = true);
CREATE INDEX idx_skill_installations_skill_id ON public.skill_installations USING btree (skill_id);
CREATE INDEX idx_skill_installations_user_id ON public.skill_installations USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS skill_installations_user_id_skill_id_key ON public.skill_installations USING btree (user_id, skill_id);

-- skill_versions
CREATE INDEX idx_skill_versions_published_at ON public.skill_versions USING btree (published_at DESC);
CREATE INDEX idx_skill_versions_skill_id ON public.skill_versions USING btree (skill_id);
CREATE UNIQUE INDEX IF NOT EXISTS skill_versions_skill_id_version_key ON public.skill_versions USING btree (skill_id, version);

-- skills
CREATE INDEX idx_skills_category ON public.skills USING btree (category);
CREATE INDEX idx_skills_forked_from ON public.skills USING btree (forked_from_id) WHERE (forked_from_id IS NOT NULL);
CREATE INDEX idx_skills_is_official ON public.skills USING btree (is_official) WHERE (is_official = true);
CREATE INDEX idx_skills_is_public ON public.skills USING btree (is_public) WHERE (is_public = true);
CREATE INDEX idx_skills_status ON public.skills USING btree (status);
CREATE INDEX idx_skills_tags ON public.skills USING gin (tags);
CREATE INDEX idx_skills_type ON public.skills USING btree (type);
CREATE UNIQUE INDEX IF NOT EXISTS skills_name_key ON public.skills USING btree (name);

-- tasks
CREATE INDEX idx_tasks_completed_at ON public.tasks USING btree (completed_at);
CREATE INDEX idx_tasks_due_date ON public.tasks USING btree (due_date);
CREATE INDEX idx_tasks_priority ON public.tasks USING btree (priority);
CREATE INDEX idx_tasks_status ON public.tasks USING btree (status);
CREATE INDEX idx_tasks_tags ON public.tasks USING gin (tags);
CREATE INDEX idx_tasks_user_id ON public.tasks USING btree (user_id);

-- trusted_users
CREATE INDEX idx_trusted_users_platform_lookup ON public.trusted_users USING btree (platform, platform_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS trusted_users_platform_platform_user_id_key ON public.trusted_users USING btree (platform, platform_user_id);

-- user_identity
CREATE INDEX idx_user_identity_user_id ON public.user_identity USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_identity_user_id_key ON public.user_identity USING btree (user_id);

-- user_identity_history
CREATE INDEX idx_user_identity_history_archived ON public.user_identity_history USING btree (archived_at DESC);
CREATE INDEX idx_user_identity_history_identity ON public.user_identity_history USING btree (identity_id);
CREATE INDEX idx_user_identity_history_user ON public.user_identity_history USING btree (user_id);

-- user_permissions
CREATE INDEX idx_user_permissions_user ON public.user_permissions USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_permissions_user_id_permission_id_key ON public.user_permissions USING btree (user_id, permission_id);

-- users
CREATE INDEX idx_users_email ON public.users USING btree (email);
CREATE INDEX idx_users_phone_number ON public.users USING btree (phone_number);
CREATE INDEX idx_users_telegram_id ON public.users USING btree (telegram_id);
CREATE INDEX idx_users_telegram_username ON public.users USING btree (telegram_username);
CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_key ON public.users USING btree (discord_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON public.users USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_key ON public.users USING btree (phone_number);
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_key ON public.users USING btree (telegram_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_username_key ON public.users USING btree (telegram_username);
CREATE UNIQUE INDEX IF NOT EXISTS users_whatsapp_id_key ON public.users USING btree (whatsapp_id);

-- workspaces
CREATE INDEX idx_workspaces_agent_id ON public.workspaces USING btree (agent_id);
CREATE INDEX idx_workspaces_branch ON public.workspaces USING btree (branch);
CREATE INDEX idx_workspaces_session_id ON public.workspaces USING btree (session_id);
CREATE INDEX idx_workspaces_status ON public.workspaces USING btree (status);
CREATE INDEX idx_workspaces_user_id ON public.workspaces USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_branch_key ON public.workspaces USING btree (branch);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_worktree_path_key ON public.workspaces USING btree (worktree_path);
-- Functions, triggers, RLS policies, and comments

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.archive_agent_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only archive if there are actual changes (not just updated_at)
  IF (OLD.name IS DISTINCT FROM NEW.name OR
      OLD.role IS DISTINCT FROM NEW.role OR
      OLD.description IS DISTINCT FROM NEW.description OR
      OLD.values IS DISTINCT FROM NEW.values OR
      OLD.relationships IS DISTINCT FROM NEW.relationships OR
      OLD.capabilities IS DISTINCT FROM NEW.capabilities OR
      OLD.metadata IS DISTINCT FROM NEW.metadata OR
      OLD.heartbeat IS DISTINCT FROM NEW.heartbeat OR
      OLD.soul IS DISTINCT FROM NEW.soul) THEN
    INSERT INTO agent_identity_history (
      identity_id, user_id, agent_id, name, role, description,
      values, relationships, capabilities, metadata, heartbeat, soul,
      version, created_at, archived_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.agent_id, OLD.name, OLD.role, OLD.description,
      OLD.values, OLD.relationships, OLD.capabilities, OLD.metadata, OLD.heartbeat, OLD.soul,
      OLD.version, OLD.created_at, NOW(), 'update'
    );

    -- Increment version
    NEW.version := COALESCE(OLD.version, 0) + 1;
    NEW.updated_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_agent_identity_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO agent_identity_history (
    identity_id, user_id, agent_id,
    name, role, description, values, relationships, capabilities, metadata,
    soul, heartbeat, backend,
    version, created_at, change_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.agent_id,
    OLD.name, OLD.role, OLD.description, OLD.values, OLD.relationships, OLD.capabilities, OLD.metadata,
    OLD.soul, OLD.heartbeat, OLD.backend,
    OLD.version, OLD.created_at, 'delete'
  );

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_agent_identity_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.name IS DISTINCT FROM NEW.name
     OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.description IS DISTINCT FROM NEW.description
     OR OLD.values IS DISTINCT FROM NEW.values
     OR OLD.relationships IS DISTINCT FROM NEW.relationships
     OR OLD.capabilities IS DISTINCT FROM NEW.capabilities
     OR OLD.metadata IS DISTINCT FROM NEW.metadata
     OR OLD.soul IS DISTINCT FROM NEW.soul
     OR OLD.heartbeat IS DISTINCT FROM NEW.heartbeat
     OR OLD.backend IS DISTINCT FROM NEW.backend THEN

    INSERT INTO agent_identity_history (
      identity_id, user_id, agent_id,
      name, role, description, values, relationships, capabilities, metadata,
      soul, heartbeat, backend,
      version, created_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.agent_id,
      OLD.name, OLD.role, OLD.description, OLD.values, OLD.relationships, OLD.capabilities, OLD.metadata,
      OLD.soul, OLD.heartbeat, OLD.backend,
      OLD.version, OLD.created_at, 'update'
    );

    NEW.version := OLD.version + 1;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_artifact_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.version IS DISTINCT FROM NEW.version THEN
    INSERT INTO artifact_history (
      artifact_id, version, title, content,
      changed_by_agent_id, change_type, created_at
    ) VALUES (
      OLD.id, OLD.version, OLD.title, OLD.content,
      NEW.metadata->>'lastEditedBy', 'update', NOW()
    )
    ON CONFLICT (artifact_id, version) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_context_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.summary IS DISTINCT FROM NEW.summary
     OR OLD.metadata IS DISTINCT FROM NEW.metadata THEN
    INSERT INTO context_history (
      context_id, user_id, context_type, context_key, summary, metadata,
      version, created_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.context_type, OLD.context_key, OLD.summary,
      OLD.metadata, OLD.version, OLD.created_at, 'update'
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_memory_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO memory_history (
    memory_id, user_id, content, source, salience, topics, metadata,
    version, created_at, change_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
    OLD.metadata, OLD.version, OLD.created_at, 'delete'
  );
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_memory_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content
     OR OLD.salience IS DISTINCT FROM NEW.salience
     OR OLD.topics IS DISTINCT FROM NEW.topics THEN
    INSERT INTO memory_history (
      memory_id, user_id, content, source, salience, topics, metadata,
      version, created_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.content, OLD.source, OLD.salience, OLD.topics,
      OLD.metadata, OLD.version, OLD.created_at, 'update'
    );
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.archive_user_identity_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO user_identity_history (
    identity_id, user_id, user_profile_md, shared_values_md, process_md,
    version, created_at, change_type
  ) VALUES (
    OLD.id, OLD.user_id, OLD.user_profile_md, OLD.shared_values_md, OLD.process_md,
    OLD.version, OLD.created_at, 'delete'
  );
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_skill_version_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content OR OLD.manifest IS DISTINCT FROM NEW.manifest THEN
    INSERT INTO skill_versions (skill_id, version, manifest, content, published_by, changelog)
    VALUES (NEW.id, NEW.current_version, NEW.manifest, NEW.content, NEW.last_published_by, NULL)
    ON CONFLICT (skill_id, version) DO UPDATE SET
      manifest = EXCLUDED.manifest,
      content = EXCLUDED.content,
      published_by = EXCLUDED.published_by,
      published_at = NOW();
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_user_identity_version_on_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.user_profile_md IS DISTINCT FROM NEW.user_profile_md
     OR OLD.shared_values_md IS DISTINCT FROM NEW.shared_values_md
     OR OLD.process_md IS DISTINCT FROM NEW.process_md THEN

    INSERT INTO user_identity_history (
      identity_id, user_id, user_profile_md, shared_values_md, process_md,
      version, created_at, change_type
    ) VALUES (
      OLD.id, OLD.user_id, OLD.user_profile_md, OLD.shared_values_md, OLD.process_md,
      OLD.version, OLD.created_at, 'update'
    );

    NEW.version = OLD.version + 1;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_skill_install_count()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE skills SET install_count = install_count - 1 WHERE id = OLD.skill_id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.increment_skill_install_count()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE skills SET install_count = install_count + 1 WHERE id = NEW.skill_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_links(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 10, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, url text, title text, description text, tags text[], similarity double precision)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    links.id,
    links.url,
    links.title,
    links.description,
    links.tags,
    1 - (links.embedding <=> query_embedding) AS similarity
  FROM links
  WHERE
    links.embedding IS NOT NULL
    AND 1 - (links.embedding <=> query_embedding) > match_threshold
    AND (p_user_id IS NULL OR links.user_id = p_user_id)
  ORDER BY links.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_messages(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 10, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, conversation_id uuid, content text, created_at timestamp with time zone, similarity double precision)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    messages.id,
    messages.conversation_id,
    messages.content,
    messages.created_at,
    1 - (messages.embedding <=> query_embedding) AS similarity
  FROM messages
  WHERE
    messages.embedding IS NOT NULL
    AND 1 - (messages.embedding <=> query_embedding) > match_threshold
    AND (p_user_id IS NULL OR messages.user_id = p_user_id)
  ORDER BY messages.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_notes(query_embedding vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 10, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, title text, content text, tags text[], similarity double precision)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    notes.id,
    notes.title,
    notes.content,
    notes.tags,
    1 - (notes.embedding <=> query_embedding) AS similarity
  FROM notes
  WHERE
    notes.embedding IS NOT NULL
    AND 1 - (notes.embedding <=> query_embedding) > match_threshold
    AND (p_user_id IS NULL OR notes.user_id = p_user_id)
  ORDER BY notes.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_project_task_completed_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.completed_at = NOW();
  ELSIF NEW.status != 'completed' AND OLD.status = 'completed' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_heartbeat()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  api_url TEXT;
BEGIN
  -- Get the API URL from config
  SELECT value INTO api_url FROM pcp_config WHERE key = 'api_url';

  -- Make HTTP POST request using net schema
  PERFORM net.http_post(
    url := api_url || '/api/admin/heartbeat',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"source": "pg_cron"}'::jsonb
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_agent_sessions_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_connected_accounts_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_contacts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_project_tasks_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER archive_agent_identity_before_delete BEFORE DELETE ON agent_identities
FOR EACH ROW EXECUTE FUNCTION archive_agent_identity_on_delete();

CREATE TRIGGER archive_agent_identity_before_update BEFORE UPDATE ON agent_identities
FOR EACH ROW EXECUTE FUNCTION archive_agent_identity_on_update();

CREATE TRIGGER update_agent_identities_updated_at BEFORE UPDATE ON agent_identities
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_agent_sessions_updated_at BEFORE UPDATE ON agent_sessions
FOR EACH ROW EXECUTE FUNCTION update_agent_sessions_updated_at();

CREATE TRIGGER artifact_version_trigger BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION archive_artifact_version();

CREATE TRIGGER update_connected_accounts_updated_at BEFORE UPDATE ON connected_accounts
FOR EACH ROW EXECUTE FUNCTION update_connected_accounts_timestamp();

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION update_contacts_updated_at();

CREATE TRIGGER context_update_archive BEFORE UPDATE ON context_summaries
FOR EACH ROW EXECUTE FUNCTION archive_context_on_update();

CREATE TRIGGER update_context_summaries_updated_at BEFORE UPDATE ON context_summaries
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_heartbeat_state_updated_at BEFORE UPDATE ON heartbeat_state
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_links_updated_at BEFORE UPDATE ON links
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER memory_delete_archive BEFORE DELETE ON memories
FOR EACH ROW EXECUTE FUNCTION archive_memory_on_delete();

CREATE TRIGGER memory_update_archive BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION archive_memory_on_update();

CREATE TRIGGER update_mini_app_records_updated_at BEFORE UPDATE ON mini_app_records
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notes_updated_at BEFORE UPDATE ON notes
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_project_task_completed BEFORE UPDATE ON project_tasks
FOR EACH ROW EXECUTE FUNCTION set_project_task_completed_at();

CREATE TRIGGER trigger_project_tasks_updated_at BEFORE UPDATE ON project_tasks
FOR EACH ROW EXECUTE FUNCTION update_project_tasks_updated_at();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_reminders_updated_at BEFORE UPDATE ON reminders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_scheduled_reminders_updated_at BEFORE UPDATE ON scheduled_reminders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_session_focus_updated_at BEFORE UPDATE ON session_focus
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_skill_installed AFTER INSERT ON skill_installations
FOR EACH ROW EXECUTE FUNCTION increment_skill_install_count();

CREATE TRIGGER trigger_skill_uninstalled AFTER DELETE ON skill_installations
FOR EACH ROW EXECUTE FUNCTION decrement_skill_install_count();

CREATE TRIGGER trigger_skill_version_on_update BEFORE UPDATE ON skills
FOR EACH ROW EXECUTE FUNCTION create_skill_version_on_update();

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_identity_updated_at BEFORE UPDATE ON user_identity
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER user_identity_archive_trigger BEFORE DELETE ON user_identity
FOR EACH ROW EXECUTE FUNCTION archive_user_identity_on_delete();

CREATE TRIGGER user_identity_version_trigger BEFORE UPDATE ON user_identity
FOR EACH ROW EXECUTE FUNCTION create_user_identity_version_on_update();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workspaces_updated_at BEFORE UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE activity_stream ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_identity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_challenge_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE links ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mini_app_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pcp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_focus ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- agent_identities
CREATE POLICY "Service role full access to agent_identities" ON agent_identities
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can delete own agent identities" ON agent_identities
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own agent identities" ON agent_identities
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own agent identities" ON agent_identities
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own agent identities" ON agent_identities
FOR SELECT
USING (auth.uid() = user_id);

-- agent_identity_history
CREATE POLICY "Service role full access to agent_identity_history" ON agent_identity_history
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can view own agent identity history" ON agent_identity_history
FOR SELECT
USING (auth.uid() = user_id);

-- agent_inbox
CREATE POLICY "Users can insert messages to their agents" ON agent_inbox
FOR INSERT
WITH CHECK ((sender_user_id = auth.uid()) OR (recipient_user_id = auth.uid()));

CREATE POLICY "Users can update their inbox messages" ON agent_inbox
FOR UPDATE
USING (recipient_user_id = auth.uid());

CREATE POLICY "Users can view their agent inbox" ON agent_inbox
FOR SELECT
USING ((recipient_user_id = auth.uid()) OR (sender_user_id = auth.uid()));

-- audit_log
CREATE POLICY "Service role full access on audit_log" ON audit_log
FOR ALL
USING (auth.role() = 'service_role'::text);

-- authorized_groups
CREATE POLICY "Service role full access on authorized_groups" ON authorized_groups
FOR ALL
USING (auth.role() = 'service_role'::text);

-- connected_accounts
CREATE POLICY "Service role full access" ON connected_accounts
FOR ALL
USING (auth.role() = 'service_role'::text);

CREATE POLICY "Users can delete own connected accounts" ON connected_accounts
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own connected accounts" ON connected_accounts
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own connected accounts" ON connected_accounts
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own connected accounts" ON connected_accounts
FOR SELECT
USING (auth.uid() = user_id);

-- context_summaries
CREATE POLICY "Users can delete own context" ON context_summaries
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own context" ON context_summaries
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own context" ON context_summaries
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own context" ON context_summaries
FOR SELECT
USING (auth.uid() = user_id);

-- conversations
CREATE POLICY "Users can delete own conversations" ON conversations
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conversations" ON conversations
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own conversations" ON conversations
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own conversations" ON conversations
FOR SELECT
USING (auth.uid() = user_id);

-- group_challenge_codes
CREATE POLICY "Service role full access on group_challenge_codes" ON group_challenge_codes
FOR ALL
USING (auth.role() = 'service_role'::text);

-- heartbeat_state
CREATE POLICY "Service role full access to heartbeat_state" ON heartbeat_state
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can manage own heartbeat state" ON heartbeat_state
FOR ALL
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own heartbeat state" ON heartbeat_state
FOR SELECT
USING (auth.uid() = user_id);

-- links
CREATE POLICY "Users can delete own links" ON links
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own links" ON links
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own links" ON links
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own links" ON links
FOR SELECT
USING (auth.uid() = user_id);

-- messages
CREATE POLICY "Users can delete own messages" ON messages
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own messages" ON messages
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own messages" ON messages
FOR SELECT
USING (auth.uid() = user_id);

-- mini_app_records
CREATE POLICY "mini_app_records_user_policy" ON mini_app_records
FOR ALL
USING (auth.uid() = user_id);

-- notes
CREATE POLICY "Users can delete own notes" ON notes
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notes" ON notes
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes" ON notes
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own notes" ON notes
FOR SELECT
USING (auth.uid() = user_id);

-- pcp_config
CREATE POLICY "Service role can manage config" ON pcp_config
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

-- permission_definitions
CREATE POLICY "Service role full access on permission_definitions" ON permission_definitions
FOR ALL
USING (auth.role() = 'service_role'::text);

-- projects
CREATE POLICY "Users can delete own projects" ON projects
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects" ON projects
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects" ON projects
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own projects" ON projects
FOR SELECT
USING (auth.uid() = user_id);

-- reminder_history
CREATE POLICY "Service role full access to reminder_history" ON reminder_history
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can view own reminder history" ON reminder_history
FOR SELECT
USING (reminder_id IN ( SELECT scheduled_reminders.id FROM scheduled_reminders WHERE (scheduled_reminders.user_id = auth.uid())));

-- reminders
CREATE POLICY "Users can delete own reminders" ON reminders
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reminders" ON reminders
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reminders" ON reminders
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own reminders" ON reminders
FOR SELECT
USING (auth.uid() = user_id);

-- scheduled_reminders
CREATE POLICY "Service role full access to scheduled_reminders" ON scheduled_reminders
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can delete own reminders" ON scheduled_reminders
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reminders" ON scheduled_reminders
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reminders" ON scheduled_reminders
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own reminders" ON scheduled_reminders
FOR SELECT
USING (auth.uid() = user_id);

-- session_focus
CREATE POLICY "Users can delete own session focus" ON session_focus
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own session focus" ON session_focus
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own session focus" ON session_focus
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own session focus" ON session_focus
FOR SELECT
USING (auth.uid() = user_id);

-- tasks
CREATE POLICY "Users can delete own tasks" ON tasks
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks" ON tasks
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks" ON tasks
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own tasks" ON tasks
FOR SELECT
USING (auth.uid() = user_id);

-- trusted_users
CREATE POLICY "Service role full access on trusted_users" ON trusted_users
FOR ALL
USING (auth.role() = 'service_role'::text);

-- user_identity
CREATE POLICY "Service role full access to user_identity" ON user_identity
FOR ALL
USING (auth.role() = 'service_role'::text)
WITH CHECK (auth.role() = 'service_role'::text);

CREATE POLICY "Users can delete own identity" ON user_identity
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own identity" ON user_identity
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own identity" ON user_identity
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can view own identity" ON user_identity
FOR SELECT
USING (auth.uid() = user_id);

-- user_identity_history
CREATE POLICY "Service role full access to user_identity_history" ON user_identity_history
FOR ALL
USING (auth.role() = 'service_role'::text)
WITH CHECK (auth.role() = 'service_role'::text);

CREATE POLICY "Users can view own identity history" ON user_identity_history
FOR SELECT
USING (auth.uid() = user_id);

-- user_permissions
CREATE POLICY "Service role full access on user_permissions" ON user_permissions
FOR ALL
USING (auth.role() = 'service_role'::text);

-- users
CREATE POLICY "Service role full access to users" ON users
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role'::text);

CREATE POLICY "Users can update own data" ON users
FOR UPDATE
USING (auth.uid() = id);

CREATE POLICY "Users can view own data" ON users
FOR SELECT
USING (auth.uid() = id);

-- workspaces
CREATE POLICY "Service role full access to workspaces" ON workspaces
FOR ALL
USING (auth.role() = 'service_role'::text)
WITH CHECK (auth.role() = 'service_role'::text);

-- ============================================================================
-- TABLE COMMENTS
-- ============================================================================

COMMENT ON TABLE activity_stream IS 'Unified event log capturing all SB activity: messages, tool calls, agent spawns, state changes. Designed for live-streaming and full auditability.';
COMMENT ON TABLE agent_identities IS 'First-class storage for AI being identities (wren, benson, myra). Each agent has structured identity data including name, role, values, and relationships.';
COMMENT ON TABLE agent_identity_history IS 'Version history for agent identity changes. Automatically populated by triggers when identities are updated or deleted.';
COMMENT ON TABLE agent_inbox IS 'Asynchronous message queue for cross-agent communication';
COMMENT ON TABLE agent_sessions IS 'Stores agent/Claude Code session information for persistence and terminal attachment';
COMMENT ON TABLE artifacts IS 'Shared documents and specs that beings collaborate on';
COMMENT ON TABLE connected_accounts IS 'Stores OAuth tokens and metadata for connected third-party accounts';
COMMENT ON TABLE heartbeat_state IS 'Tracks per-user heartbeat check times and quiet hours preferences.';
COMMENT ON TABLE mini_app_records IS 'Flexible storage for mini-app data with typed indexed fields';
COMMENT ON TABLE pcp_config IS 'Configuration key-value store for PCP system settings';
COMMENT ON TABLE project_tasks IS 'Tasks tied to projects for tracking work across sessions';
COMMENT ON TABLE reminder_history IS 'Audit log of reminder delivery attempts and user responses.';
COMMENT ON TABLE scheduled_reminders IS 'User-created reminders and recurring tasks. Supports one-time and cron-based scheduling.';
COMMENT ON TABLE skill_installations IS 'User skill references - tracks which skills each user has installed';
COMMENT ON TABLE skill_versions IS 'Version history for skills, enabling rollback and pinning';
COMMENT ON TABLE skills IS 'Central registry of all available skills (official + community)';
COMMENT ON TABLE user_identity IS 'User-level identity files (USER.md, VALUES.md) that are shared across all agents for a user.';
COMMENT ON TABLE user_identity_history IS 'Version history for user identity changes, enabling rollback and audit.';
COMMENT ON TABLE workspaces IS 'Tracks git worktrees for parallel agent work. Workspaces are separate from sessions and can outlive them.';

-- ============================================================================
-- COLUMN COMMENTS
-- ============================================================================

-- activity_stream
COMMENT ON COLUMN activity_stream.type IS 'Event type: message_in/out, tool_call/result, agent_spawn/complete, state_change, thinking, error';
COMMENT ON COLUMN activity_stream.subtype IS 'Event subtype: for tool_call this is the tool name (web_search, read_file), for state_change this is the entity type (task, memory)';
COMMENT ON COLUMN activity_stream.content IS 'Human-readable summary of the event, always present';
COMMENT ON COLUMN activity_stream.payload IS 'Type-specific data as JSONB. Structure varies by event type.';
COMMENT ON COLUMN activity_stream.parent_id IS 'Parent event for hierarchical relationships: tool_result -> tool_call, agent events -> spawn event';
COMMENT ON COLUMN activity_stream.correlation_id IS 'Groups related events into logical units (e.g., research session, multi-step task)';
COMMENT ON COLUMN activity_stream.artifact_id IS 'Pointer to artifacts table for large outputs that should not be embedded';
COMMENT ON COLUMN activity_stream.child_session_id IS 'For agent_spawn: points to the sub-agents session for their activity stream';

-- agent_identities
COMMENT ON COLUMN agent_identities.agent_id IS 'Unique identifier for the AI being: wren (Claude Code), benson (Clawdbot), myra (messaging bridge)';
COMMENT ON COLUMN agent_identities.values IS 'Array of core values this agent holds, e.g., ["collaborative partnership", "transparent communication"]';
COMMENT ON COLUMN agent_identities.relationships IS 'Map of agent_id to relationship description, e.g., {"benson": "conversational partner via Clawdbot"}';
COMMENT ON COLUMN agent_identities.capabilities IS 'Array of capabilities this agent has, e.g., ["code development", "architecture planning"]';
COMMENT ON COLUMN agent_identities.heartbeat IS 'HEARTBEAT.md - Operational wake-up checklist and periodic tasks';
COMMENT ON COLUMN agent_identities.soul IS 'SOUL.md - Core essence and philosophical grounding (future use)';
COMMENT ON COLUMN agent_identities.backend IS 'CLI backend for this agent: claude, codex, gemini. Used by sb CLI to auto-resolve which tool to launch.';

-- agent_inbox
COMMENT ON COLUMN agent_inbox.message_type IS 'Type of message: message (general), task_request (work request), session_resume (wake up request), notification (FYI)';
COMMENT ON COLUMN agent_inbox.recipient_session_id IS 'For session_resume messages, the recipient session to continue';

-- agent_sessions
COMMENT ON COLUMN agent_sessions.session_id IS 'Claude Code or agent session ID for resumption';

-- artifacts
COMMENT ON COLUMN artifacts.uri IS 'MCP resource URI (e.g., pcp://specs/orchestration)';
COMMENT ON COLUMN artifacts.collaborators IS 'Agent IDs with edit access';

-- connected_accounts
COMMENT ON COLUMN connected_accounts.access_token IS 'OAuth access token - encrypted at rest';
COMMENT ON COLUMN connected_accounts.refresh_token IS 'OAuth refresh token - encrypted at rest';
COMMENT ON COLUMN connected_accounts.scopes IS 'OAuth scopes granted during authorization';

-- heartbeat_state
COMMENT ON COLUMN heartbeat_state.last_checks IS 'JSON object tracking last check times: {"email": "2024-01-27T12:00:00Z", "calendar": "2024-01-27T11:30:00Z"}';

-- links
COMMENT ON COLUMN links.embedding IS 'Voyage AI embedding (voyage-4, 1024 dims)';

-- memories
COMMENT ON COLUMN memories.agent_id IS 'Which AI being created this memory (wren, benson, etc). NULL = shared memory.';

-- messages
COMMENT ON COLUMN messages.embedding IS 'Voyage AI embedding (voyage-4, 1024 dims)';

-- mini_app_records
COMMENT ON COLUMN mini_app_records.type IS 'Record type within the app (e.g., split, expense, contact)';
COMMENT ON COLUMN mini_app_records.amount IS 'Extracted monetary value for efficient filtering';
COMMENT ON COLUMN mini_app_records.recorded_at IS 'When this record occurred (for time-based queries)';
COMMENT ON COLUMN mini_app_records.text IS 'Searchable text content';
COMMENT ON COLUMN mini_app_records.tags IS 'Categorization tags for filtering';

-- notes
COMMENT ON COLUMN notes.embedding IS 'Voyage AI embedding (voyage-4, 1024 dims)';

-- project_tasks
COMMENT ON COLUMN project_tasks.blocked_by IS 'Array of task IDs that must complete before this task';
COMMENT ON COLUMN project_tasks.created_by IS 'Who/what created this task (user, claude, session ID)';

-- scheduled_reminders
COMMENT ON COLUMN scheduled_reminders.cron_expression IS 'Standard cron syntax (minute hour day month weekday). NULL for one-time reminders.';
COMMENT ON COLUMN scheduled_reminders.delivery_channel IS 'Platform to deliver reminder: telegram, whatsapp, or email.';

-- session_logs
COMMENT ON COLUMN session_logs.compacted_at IS 'When this log was compacted into a memory (soft-delete)';
COMMENT ON COLUMN session_logs.compacted_into_memory_id IS 'The memory this log was compacted into';

-- sessions
COMMENT ON COLUMN sessions.claude_session_id IS 'Claude Code session ID for --resume';
COMMENT ON COLUMN sessions.status IS 'active, paused, resumable, completed';
COMMENT ON COLUMN sessions.working_dir IS 'Working directory for the session';
COMMENT ON COLUMN sessions.context IS 'Brief description of current work state';

-- user_identity
COMMENT ON COLUMN user_identity.user_profile_md IS 'USER.md content - describes who the human is, their background, preferences, etc.';
COMMENT ON COLUMN user_identity.shared_values_md IS 'VALUES.md content - core values shared by all SBs working with this user.';
COMMENT ON COLUMN user_identity.process_md IS 'PROCESS.md content - shared team operational process.';

-- users
COMMENT ON COLUMN users.phone_number IS 'Phone number in E.164 format (e.g., +14155551234)';
COMMENT ON COLUMN users.timezone IS 'IANA timezone identifier for the user (e.g., America/Los_Angeles)';

-- workspaces
COMMENT ON COLUMN workspaces.agent_id IS 'The agent that owns/created this workspace (e.g., wren, benson).';
COMMENT ON COLUMN workspaces.session_id IS 'Currently linked session. NULL when no session is actively using the workspace.';
COMMENT ON COLUMN workspaces.repo_root IS 'The original repo root directory this worktree was created from.';
COMMENT ON COLUMN workspaces.worktree_path IS 'Full filesystem path to the worktree directory.';
COMMENT ON COLUMN workspaces.branch IS 'Git branch name, typically following {agent}/{type}/{slug} convention.';
COMMENT ON COLUMN workspaces.status IS 'active = in use, idle = no active session, archived = work done but not cleaned, cleaned = worktree removed.';
