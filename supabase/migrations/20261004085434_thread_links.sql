-- Thread links: a thread names another thread, or a library artifact, as
-- related to it (Conor, 2026-10-04, thread:thread-links).
--
-- One row is one directed edge. It is stored once, from the thread that made
-- the link, and read in both directions: the source lists it under "links to"
-- and the target under "linked from". No mirror row is written, so the
-- direction keeps its meaning ("pr:701 implements the spec" does not turn
-- around).
--
-- A thread target is a KEY, not a row id. A link may name `pr:701` before
-- anyone has opened a conversation on it, the same "no thread yet" state the
-- /threads spine already shows; the key resolves to its row, in the link's
-- workspace, when the link is read. An artifact target is the artifact's id,
-- resolved through URI aliases when the link is written, so renaming a spec
-- keeps its links.
--
-- Named thread_links because `links` is already the save_link bookmark table.

CREATE TABLE public.thread_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  source_thread_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_thread_key text,
  target_artifact_id uuid REFERENCES public.artifacts (id) ON DELETE CASCADE,
  -- One column the uniqueness constraint can name, whichever kind the target
  -- is, so a re-link is a single INSERT ... ON CONFLICT rather than a
  -- read-then-write.
  target_ref text GENERATED ALWAYS AS (
    COALESCE(target_thread_key, target_artifact_id::text)
  ) STORED,
  -- The kinds are validated by the application (relates, implements,
  -- continues, supersedes), so adding one is a code change, not a migration.
  relation text NOT NULL DEFAULT 'relates',
  note text,
  -- 'explicit' (link_thread), 'send' (send_to_inbox links or
  -- relatedArtifactUri). 'mention' is reserved for text extraction.
  origin text NOT NULL DEFAULT 'explicit',
  source_message_id uuid REFERENCES public.inbox_thread_messages (id) ON DELETE SET NULL,
  -- The principal who last wrote the link: a re-link updates the row.
  linked_by_kind text NOT NULL,
  linked_by_sb_id uuid REFERENCES public.agent_identities (id) ON DELETE SET NULL,
  linked_by_user_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The source thread lives in the link's workspace.
  CONSTRAINT thread_links_source_thread_fkey
    FOREIGN KEY (source_thread_id, workspace_id)
    REFERENCES public.inbox_threads (id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT thread_links_target_kind_check CHECK (target_kind IN ('thread', 'artifact')),
  CONSTRAINT thread_links_target_shape_check CHECK (
    (target_kind = 'thread' AND target_thread_key IS NOT NULL AND target_artifact_id IS NULL)
    OR (target_kind = 'artifact' AND target_artifact_id IS NOT NULL AND target_thread_key IS NULL)
  ),
  CONSTRAINT thread_links_origin_check CHECK (origin IN ('explicit', 'send', 'mention')),
  CONSTRAINT thread_links_linked_by_kind_check CHECK (linked_by_kind IN ('sb', 'user', 'system')),
  CONSTRAINT thread_links_relation_length_check CHECK (char_length(relation) BETWEEN 1 AND 32),
  CONSTRAINT thread_links_note_length_check CHECK (note IS NULL OR char_length(note) <= 280),
  CONSTRAINT thread_links_target_key_length_check CHECK (
    target_thread_key IS NULL OR char_length(target_thread_key) BETWEEN 3 AND 200
  ),
  CONSTRAINT thread_links_source_target_key UNIQUE (source_thread_id, target_kind, target_ref)
);

-- "Linked from": every link naming a thread key, in a workspace.
CREATE INDEX thread_links_workspace_target_key_idx
  ON public.thread_links (workspace_id, target_thread_key)
  WHERE target_kind = 'thread';

-- "Linked from" for an artifact, and the ON DELETE CASCADE from artifacts.
CREATE INDEX thread_links_target_artifact_idx
  ON public.thread_links (target_artifact_id)
  WHERE target_kind = 'artifact';

CREATE TRIGGER update_thread_links_updated_at
  BEFORE UPDATE ON public.thread_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Server-only table: the API reaches it with the service role, which bypasses
-- RLS. Enabled with no policies so the publishable key reads nothing.
ALTER TABLE public.thread_links ENABLE ROW LEVEL SECURITY;
